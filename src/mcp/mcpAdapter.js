const fs = require("fs");
const path = require("path");
const Lark = require("@larksuiteoapi/node-sdk");
const LARK_RECEIVER_CACHE_FILE = path.resolve(process.cwd(), ".lark-receiver-cache.json");
/**
 * @returns {string} - Lark 用户认证缓存文件路径
 */
function getLarkUserTokenCacheFile() {
  const customPath = String(process.env.LARK_USER_TOKEN_CACHE_FILE || "").trim();
  if (customPath) {
    return path.resolve(process.cwd(), customPath);
  }
  return path.resolve(process.cwd(), ".lark-user-token-cache.json");
}

function createMetric(base) {
  const pv = 1000 + (base % 3000);
  const uv = 400 + (base % 1200);
  const ctr = Number(((uv / pv) * 100).toFixed(2));
  return { pv, uv, ctr };
}

const WEATHER_CODE_LABEL = {
  0: "晴",
  1: "大部晴朗",
  2: "多云",
  3: "阴",
  45: "雾",
  48: "雾凇",
  51: "小毛毛雨",
  53: "毛毛雨",
  55: "强毛毛雨",
  56: "冻毛毛雨",
  57: "强冻毛毛雨",
  61: "小雨",
  63: "中雨",
  65: "大雨",
  66: "冻雨",
  67: "强冻雨",
  71: "小雪",
  73: "中雪",
  75: "大雪",
  77: "冰粒",
  80: "小阵雨",
  81: "中阵雨",
  82: "强阵雨",
  85: "小阵雪",
  86: "强阵雪",
  95: "雷暴",
  96: "雷暴伴小冰雹",
  99: "雷暴伴大冰雹",
};
const CITY_ALIAS = {
  北京: "Beijing",
  上海: "Shanghai",
  广州: "Guangzhou",
  深圳: "Shenzhen",
  杭州: "Hangzhou",
  南京: "Nanjing",
  成都: "Chengdu",
  重庆: "Chongqing",
  武汉: "Wuhan",
  西安: "Xi'an",
  天津: "Tianjin",
};

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return { signal: controller.signal, timer };
}

async function fetchJson(url, timeoutMs = 8000) {
  const { signal, timer } = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, { signal });
    if (!response.ok) {
      throw new Error(`天气服务请求失败: ${response.status}`);
    }
    return await response.json();
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("天气服务请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function pickBestLocation(city, locations) {
  const normalizedCity = city.trim().toLowerCase();
  const hasChinese = /[\u4e00-\u9fa5]/.test(city);
  const ranked = locations
    .map((location) => {
      const name = String(location?.name || "").toLowerCase();
      let score = 0;
      if (name === normalizedCity) {
        score += 100;
      } else if (name.includes(normalizedCity)) {
        score += 60;
      }
      if (hasChinese && location?.country_code === "CN") {
        score += 20;
      }
      const featureCode = String(location?.feature_code || "");
      if (featureCode === "PPLC") {
        score += 120;
      } else if (featureCode.startsWith("PPLA")) {
        score += 80;
      } else if (featureCode === "PPL") {
        score += 20;
      }
      const population = Number(location?.population || 0);
      score += Math.min(20, Math.floor(population / 1_000_000));
      return { location, score };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.location || null;
}

// 模拟实现
async function getClicktagInfo({ clicktags }) {
  const tags = String(clicktags || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const data = tags.map((tag) => {
    const seed = [...tag].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const metric = createMetric(seed);
    return {
      clicktag: tag,
      ...metric,
    };
  });

  return data;
}

async function getWeatherInfo({ city }) {
  const normalizedCity = String(city || "").trim();
  const cityQuery = CITY_ALIAS[normalizedCity] || normalizedCity;
  // 查询地理位置
  const geoUrl =
    "https://geocoding-api.open-meteo.com/v1/search?" +
    new URLSearchParams({
      name: cityQuery,
      count: "10",
      language: "zh",
      format: "json",
    }).toString();
  const geoData = await fetchJson(geoUrl);
  const locations = Array.isArray(geoData?.results) ? geoData.results : [];
  // 肯能返回的有重名的城市，需要根据人口数和特征码筛选
  const location = pickBestLocation(cityQuery, locations);
  if (!location) {
    throw new Error(`未找到城市: ${normalizedCity}`);
  }

  const weatherUrl =
    "https://api.open-meteo.com/v1/forecast?" +
    new URLSearchParams({
      latitude: String(location.latitude),
      longitude: String(location.longitude),
      current: "temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code",
      timezone: "auto",
    }).toString();
  const weatherData = await fetchJson(weatherUrl);
  const current = weatherData?.current;
  if (!current) {
    throw new Error("天气服务返回异常");
  }
  const weatherCode = Number(current.weather_code);

  return {
    city: location.name || normalizedCity,
    country: location.country || "",
    admin1: location.admin1 || "",
    condition: WEATHER_CODE_LABEL[weatherCode] || "未知",
    weatherCode,
    temperature: current.temperature_2m,
    humidity: current.relative_humidity_2m,
    windSpeed: current.wind_speed_10m,
    observedAt: current.time,
    unit: {
      temperature: weatherData?.current_units?.temperature_2m || "°C",
      humidity: "%",
      windSpeed: weatherData?.current_units?.wind_speed_10m || "km/h",
    },
  };
}

function normalizeAShareSymbol(input) {
  const raw = String(input || "").trim().toLowerCase();
  const normalized = raw.replace(/\s+/g, "").replace(/^([a-z]{2})\./, "$1");
  const prefixedMatch = normalized.match(/^(sh|sz|bj)(\d{6})$/);
  if (prefixedMatch) {
    const prefix = prefixedMatch[1];
    const symbol = prefixedMatch[2];
    if (prefix === "sh") {
      return { exchange: "SH", symbol, secid: `1.${symbol}` };
    }
    if (prefix === "sz") {
      return { exchange: "SZ", symbol, secid: `0.${symbol}` };
    }
    return { exchange: "BJ", symbol, secid: `0.${symbol}` };
  }

  const plainMatch = normalized.match(/^(\d{6})$/);
  if (!plainMatch) {
    throw new Error("股票代码格式不合法，请输入 6 位 A 股代码");
  }
  const symbol = plainMatch[1];
  if (/^6/.test(symbol)) {
    return { exchange: "SH", symbol, secid: `1.${symbol}` };
  }
  if (/^(0|3)/.test(symbol)) {
    return { exchange: "SZ", symbol, secid: `0.${symbol}` };
  }
  if (/^(4|8)/.test(symbol)) {
    return { exchange: "BJ", symbol, secid: `0.${symbol}` };
  }
  throw new Error("暂不支持该市场代码，请输入沪深北 A 股代码");
}

function toYyyyMmDd(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function toNum(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

// 获取股票信息
async function getAStockHistory({ symbol }) {
  const normalized = normalizeAShareSymbol(symbol);
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setFullYear(endDate.getFullYear() - 1);

  const url =
    "https://push2his.eastmoney.com/api/qt/stock/kline/get?" +
    new URLSearchParams({
      secid: normalized.secid,
      fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58",
      klt: "101",
      fqt: "1",
      beg: toYyyyMmDd(startDate),
      end: toYyyyMmDd(endDate),
      lmt: "400",
    }).toString();

  const payload = await fetchJson(url, 10000);
  const klineRows = Array.isArray(payload?.data?.klines) ? payload.data.klines : [];
  if (!klineRows.length) {
    throw new Error("未获取到股票历史数据");
  }

  const points = klineRows
    .map((row) => String(row || "").split(","))
    .filter((items) => items.length >= 7)
    .map((items) => ({
      date: items[0],
      open: toNum(items[1]),
      close: toNum(items[2]),
      high: toNum(items[3]),
      low: toNum(items[4]),
      volume: toNum(items[5]),
      turnover: toNum(items[6]),
    }));

  if (!points.length) {
    throw new Error("股票历史数据为空");
  }

  const first = points[0];
  const last = points[points.length - 1];
  const highest = points.reduce((acc, item) => Math.max(acc, item.high), points[0].high);
  const lowest = points.reduce((acc, item) => Math.min(acc, item.low), points[0].low);
  const change = Number((last.close - first.close).toFixed(2));
  const changePercent = first.close
    ? Number((((last.close - first.close) / first.close) * 100).toFixed(2))
    : 0;

  return {
    exchange: normalized.exchange,
    symbol: normalized.symbol,
    secid: normalized.secid,
    from: first.date,
    to: last.date,
    summary: {
      startClose: first.close,
      endClose: last.close,
      change,
      changePercent,
      highest,
      lowest,
      pointCount: points.length,
    },
    points,
    chart: {
      labels: points.map((item) => item.date),
      closeSeries: points.map((item) => item.close),
    },
  };
}

/**
 * @param {string} domainInput - Lark 域名输入
 * @returns {Lark.Domain} - Lark 域名枚举值
 */
function normalizeLarkDomain(domainInput) {
  const normalized = String(domainInput || "lark").trim().toLowerCase();
  if (normalized === "feishu") {
    return Lark.Domain.Feishu;
  }
  if (normalized === "lark") {
    return Lark.Domain.Lark;
  }
  if (normalized.startsWith("http://") || normalized.startsWith("https://")) {
    return normalized;
  }
  return Lark.Domain.Lark;
}

/**
 * @param {string} domainInput - Lark 域名输入
 * @returns {string} - Lark Open API 基础 URL
 */
function getLarkOpenApiBaseUrl(domainInput) {
  const normalized = String(domainInput || "lark").trim().toLowerCase();
  if (normalized === "feishu") {
    return "https://open.feishu.cn";
  }
  if (normalized === "lark") {
    return "https://open.larksuite.com";
  }
  const directUrl = String(domainInput || "").trim();
  if (!directUrl) {
    return "https://open.larksuite.com";
  }
  return directUrl.replace(/\/+$/, "");
}

/**
 * @param {string} appTypeInput - Lark 应用类型输入
 * @returns {Lark.AppType} - Lark 应用类型枚举值
 */
function normalizeLarkAppType(appTypeInput) {
  const normalized = String(appTypeInput || "self_build").trim().toLowerCase();
  if (normalized === "marketplace") {
    return Lark.AppType.Marketplace;
  }
  return Lark.AppType.SelfBuild;
}

// 创建lark client
function createLarkApiClient() {
  const appId = String(process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.LARK_APP_SECRET || "").trim();
  if (!appId || !appSecret) {
    return null;
  }
  return new Lark.Client({
    appId,
    appSecret,
    appType: normalizeLarkAppType(process.env.LARK_APP_TYPE),
    domain: normalizeLarkDomain(process.env.LARK_DOMAIN),
  });
}

/**
 * @returns {Object} - Lark 认证配置对象
 */
function createLarkAuthConfig() {
  const appId = String(process.env.LARK_APP_ID || "").trim();
  const appSecret = String(process.env.LARK_APP_SECRET || "").trim();
  if (!appId || !appSecret) {
    throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
  }
  return {
    appId,
    appSecret,
    baseUrl: getLarkOpenApiBaseUrl(process.env.LARK_DOMAIN),
  };
}

/**
 * @returns {Object} - Lark 用户认证配置对象
 */
function createLarkUserAuthConfig() {
  const rawToken = String(process.env.LARK_USER_ACCESS_TOKEN || "").trim();
  const userAccessToken = rawToken.replace(/^Bearer\s+/i, "").trim();
  if (!userAccessToken) {
    throw new Error("缺少 LARK_USER_ACCESS_TOKEN");
  }
  return {
    baseUrl: getLarkOpenApiBaseUrl(process.env.LARK_DOMAIN),
    token: userAccessToken,
  };
}

/**
 * @returns {Object} - Lark 用户认证缓存对象
 */
function readLarkUserTokenCache() {
  try {
    const file = getLarkUserTokenCacheFile();
    if (!fs.existsSync(file)) {
      return null;
    }
    const raw = fs.readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw);
    const userAccessToken = String(parsed?.userAccessToken || "").trim();
    if (!userAccessToken) {
      return null;
    }
    return {
      userAccessToken,
      refreshToken: String(parsed?.refreshToken || "").trim(),
      tokenType: String(parsed?.tokenType || "").trim(),
      scope: String(parsed?.scope || "").trim(),
      userId: String(parsed?.userId || "").trim(),
      openId: String(parsed?.openId || "").trim(),
      name: String(parsed?.name || "").trim(),
      tenantKey: String(parsed?.tenantKey || "").trim(),
      expiresAt: Number(parsed?.expiresAt || 0),
      refreshExpiresAt: Number(parsed?.refreshExpiresAt || 0),
      updatedAt: String(parsed?.updatedAt || "").trim(),
    };
  } catch (_) {
    return null;
  }
}

/**
 * @param {Object} data - Lark 用户认证缓存数据
 * @returns {Object} - Lark 用户认证缓存对象
 */
function writeLarkUserTokenCache(data = {}) {
  const file = getLarkUserTokenCacheFile();
  const payload = {
    userAccessToken: String(data?.userAccessToken || "").trim(),
    refreshToken: String(data?.refreshToken || "").trim(),
    tokenType: String(data?.tokenType || "").trim(),
    scope: String(data?.scope || "").trim(),
    userId: String(data?.userId || "").trim(),
    openId: String(data?.openId || "").trim(),
    name: String(data?.name || "").trim(),
    tenantKey: String(data?.tenantKey || "").trim(),
    expiresAt: Number(data?.expiresAt || 0),
    refreshExpiresAt: Number(data?.refreshExpiresAt || 0),
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  return payload;
}

  function getTokenExpireAt(expiresInSeconds) {
  const seconds = Number(expiresInSeconds || 0);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Date.now() + seconds * 1000;
}

/**
 * @param {number} expiresAt - 令牌过期时间戳
 * @param {number} skewMs - 令牌过期时间偏移量（毫秒）
 * @returns {boolean} - 是否令牌过期
 */
function isTokenExpired(expiresAt, skewMs = 2 * 60 * 1000) {
  const ts = Number(expiresAt || 0);
  if (!Number.isFinite(ts) || ts <= 0) {
    return false;
  }
  return Date.now() + skewMs >= ts;
}

/**
 * @param {Object} data - Lark 认证响应数据
 * @returns {Object} - Lark 用户认证缓存对象 返回的认证数据统一整理成项目内部固定结构
 */
function normalizeLarkAuthenPayload(data = {}) {
  return {
    userAccessToken: String(data?.access_token || "").trim(),
    refreshToken: String(data?.refresh_token || "").trim(),
    tokenType: String(data?.token_type || "").trim(),
    scope: String(data?.scope || "").trim(),
    userId: String(data?.user_id || "").trim(),
    openId: String(data?.open_id || "").trim(),
    name: String(data?.name || "").trim(),
    tenantKey: String(data?.tenant_key || "").trim(),
    expiresAt: getTokenExpireAt(data?.expires_in),
    refreshExpiresAt: getTokenExpireAt(data?.refresh_expires_in),
  };
}

/**
 * @param {string} code - OAuth code
 * @returns {Object} - Lark 用户认证缓存对象
 */
async function exchangeLarkUserAccessTokenByCode({ code }) {
  const authCode = String(code || "").trim();
  if (!authCode) {
    throw new Error("缺少 OAuth code");
  }
  const client = createLarkApiClient();
  if (!client) {
    throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
  }
  const response = await client.authen.v1.accessToken.create({
    data: {
      grant_type: "authorization_code",
      code: authCode,
    },
  });
  if (Number(response?.code || 0) !== 0) {
    throw new Error(`获取 user_access_token 失败: ${response?.msg || "unknown error"}`);
  }
  const normalized = normalizeLarkAuthenPayload(response?.data || {});
  if (!normalized.userAccessToken) {
    throw new Error("返回的 user_access_token 为空");
  }
  const cached = writeLarkUserTokenCache(normalized);
  return {
    connected: true,
    source: "oauth_code",
    userId: cached.userId,
    openId: cached.openId,
    name: cached.name,
    tenantKey: cached.tenantKey,
    scope: cached.scope,
    expiresAt: cached.expiresAt,
    refreshExpiresAt: cached.refreshExpiresAt,
    updatedAt: cached.updatedAt,
  };
}

/**
 * @param {string} refreshToken - Lark 用户刷新令牌
 * @returns {Object} - Lark 用户认证缓存对象
 */
async function refreshLarkUserAccessToken(refreshToken) {
  const normalizedRefreshToken = String(refreshToken || "").trim();
  if (!normalizedRefreshToken) {
    throw new Error("缺少 refresh_token");
  }
  const client = createLarkApiClient();
  if (!client) {
    throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
  }
  const response = await client.authen.v1.refreshAccessToken.create({
    data: {
      grant_type: "refresh_token",
      refresh_token: normalizedRefreshToken,
    },
  });
  if (Number(response?.code || 0) !== 0) {
    throw new Error(`刷新 user_access_token 失败: ${response?.msg || "unknown error"}`);
  }
  const normalized = normalizeLarkAuthenPayload(response?.data || {});
  if (!normalized.userAccessToken) {
    throw new Error("刷新后 user_access_token 为空");
  }
  return normalized;
}

// 获取最新token
async function getLarkUserAuthConfig() {
  try {
    const envConfig = createLarkUserAuthConfig();
    return {
      baseUrl: envConfig.baseUrl,
      token: envConfig.token,
      source: "env",
    };
  } catch (_) {}
  const baseUrl = getLarkOpenApiBaseUrl(process.env.LARK_DOMAIN);
  const cached = readLarkUserTokenCache();
  if (!cached?.userAccessToken) {
    throw new Error("缺少 LARK_USER_ACCESS_TOKEN，且本地 OAuth token 缓存不存在");
  }
  if (!isTokenExpired(cached.expiresAt)) {
    return {
      baseUrl,
      token: cached.userAccessToken,
      source: "cache",
    };
  }
  if (!cached.refreshToken) {
    throw new Error("user_access_token 已过期，且缺少 refresh_token");
  }
  const refreshed = await refreshLarkUserAccessToken(cached.refreshToken);
  const merged = writeLarkUserTokenCache({
    ...cached,
    ...refreshed,
    refreshToken: refreshed.refreshToken || cached.refreshToken,
    scope: refreshed.scope || cached.scope,
    userId: refreshed.userId || cached.userId,
    openId: refreshed.openId || cached.openId,
    name: refreshed.name || cached.name,
    tenantKey: refreshed.tenantKey || cached.tenantKey,
  });
  return {
    baseUrl,
    token: merged.userAccessToken,
    source: "refresh",
  };
}

/**
 * @returns {string} - Lark 认证主机
 */
function getLarkAuthHost() {
  const custom = String(process.env.LARK_OAUTH_AUTHORIZE_BASE || "").trim();
  if (custom) {
    return custom.replace(/\/+$/, "");
  }
  const domain = String(process.env.LARK_DOMAIN || "lark").trim().toLowerCase();
  if (domain === "feishu") {
    return "https://accounts.feishu.cn";
  }
  return "https://accounts.larksuite.com";
}

/**
 * @returns {string} - Lark OAuth 重定向 URI 用户授权完成后，把 code 回调到哪个地址。
 */
function getLarkOauthRedirectUri() {
  const configured = String(process.env.LARK_OAUTH_REDIRECT_URI || "").trim();
  if (configured) {
    return configured;
  }
  const port = String(process.env.PORT || "8001").trim();
  return `http://localhost:${port}/api/lark/oauth/callback`;
}

/**
 * @returns {string[]} - Lark OAuth 作用域
 */
function parseLarkScopes(source) {
  return [...new Set(String(source || "").split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function normalizeGrantedOauthScopesFromApplication(scopes = []) {
  const granted = (Array.isArray(scopes) ? scopes : [])
    .filter((item) => Number(item?.grant_status || 0) === 1)
    .map((item) => String(item?.scope_name || "").trim())
    .filter(Boolean);
  if (!granted.includes("offline_access")) {
    granted.push("offline_access");
  }
  return [...new Set(granted)];
}

/**
 * @returns {string[]} - Lark OAuth 作用域
 */
async function getLarkOauthScopes() {
  const defaults = ["calendar:calendar:readonly", "calendar:calendar", "offline_access"];
  const configured = parseLarkScopes(process.env.LARK_OAUTH_SCOPES);
  try {
    const appId = String(process.env.LARK_APP_ID || "").trim();
    const client = createLarkApiClient();
    if (appId && client?.application?.v6?.scope?.list) {
      const response = await client.application.v6.scope.list({
        params: {
          app_id: appId,
        },
      });
      if (Number(response?.code || 0) === 0) {
        const apiScopes = normalizeGrantedOauthScopesFromApplication(response?.data?.scopes);
        if (apiScopes.length) {
          return apiScopes;
        }
      }
    }
  } catch (_) {}
  if (configured.length) {
    return configured;
  }
  return defaults;
}

async function getLarkOAuthAuthorizeUrl({ state } = {}) {
  const { appId } = createLarkAuthConfig();
  const scopes = await getLarkOauthScopes();
  const query = new URLSearchParams({
    app_id: appId,
    redirect_uri: getLarkOauthRedirectUri(),
    response_type: "code",
    scope: scopes.join(" "),
  });
  const normalizedState = String(state || "").trim();
  if (normalizedState) {
    query.set("state", normalizedState);
  }
  return `${getLarkAuthHost()}/open-apis/authen/v1/authorize?${query.toString()}`;
}

function isLarkReauthRequiredError(errorLike) {
  const message = String(errorLike?.message || errorLike || "").toLowerCase();
  if (!message) {
    return false;
  }
  const keywords = [
    "99991679",
    "unauthorized",
    "request user re-authorization",
    "用户授权",
    "缺少 lark_user_access_token",
    "缺少 refresh_token",
    "user_access_token 已过期",
    "刷新 user_access_token 失败",
    "invalid access token",
    "access token is expired",
    "permission denied",
  ];
  return keywords.some((keyword) => message.includes(keyword));
}

async function buildLarkReauthHintText() {
  try {
    const authorizeUrl = await getLarkOAuthAuthorizeUrl({
      state: `reauth_${Date.now()}`,
    });
    return `检测到当前需要重新授权。请点击授权链接完成授权：${authorizeUrl}`;
  } catch (_) {
    return "检测到当前需要重新授权。请访问 /api/lark/oauth/url 获取授权链接并完成授权。";
  }
}

async function withLarkReauthHint(task) {
  try {
    return await task();
  } catch (error) {
    if (!isLarkReauthRequiredError(error)) {
      throw error;
    }
    const baseMessage = String(error?.message || error || "Lark 调用失败");
    const hint = await buildLarkReauthHintText();
    throw new Error(`${baseMessage}\n${hint}`);
  }
}

function getLarkOAuthTokenStatus() {
  const envToken = String(process.env.LARK_USER_ACCESS_TOKEN || "").trim().replace(/^Bearer\s+/i, "");
  if (envToken) {
    return {
      connected: true,
      source: "env",
      hasRefreshToken: false,
      expiresAt: 0,
      refreshExpiresAt: 0,
      userId: "",
      openId: "",
      name: "",
      tenantKey: "",
      scope: "",
      updatedAt: "",
    };
  }
  const cached = readLarkUserTokenCache();
  if (!cached?.userAccessToken) {
    return {
      connected: false,
      source: "none",
      hasRefreshToken: false,
      expiresAt: 0,
      refreshExpiresAt: 0,
      userId: "",
      openId: "",
      name: "",
      tenantKey: "",
      scope: "",
      updatedAt: "",
    };
  }
  return {
    connected: true,
    source: "cache",
    hasRefreshToken: Boolean(cached.refreshToken),
    expiresAt: cached.expiresAt,
    refreshExpiresAt: cached.refreshExpiresAt,
    userId: cached.userId,
    openId: cached.openId,
    name: cached.name,
    tenantKey: cached.tenantKey,
    scope: cached.scope,
    updatedAt: cached.updatedAt,
  };
}

async function fetchLarkJson({ url, method = "GET", body, timeoutMs = 10000, accessToken }) {
  const { signal, timer } = createTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        Authorization: `Bearer ${accessToken}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await response.json();
    if (!response.ok) {
      const detail = String(json?.msg || "").trim();
      throw new Error(`Lark OpenAPI 请求失败: ${response.status}${detail ? ` (${detail})` : ""}`);
    }
    if (Number(json?.code || 0) !== 0) {
      throw new Error(`Lark OpenAPI 调用失败: ${json?.msg || "unknown error"}`);
    }
    return json;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Lark OpenAPI 请求超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function getTenantAccessToken() {
  const { appId, appSecret, baseUrl } = createLarkAuthConfig();
  const { signal, timer } = createTimeoutSignal(10000);
  try {
    const response = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      signal,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        app_id: appId,
        app_secret: appSecret,
      }),
    });
    const json = await response.json();
    if (!response.ok) {
      throw new Error(`获取 tenant_access_token 失败: ${response.status}`);
    }
    if (Number(json?.code || 0) !== 0) {
      throw new Error(`获取 tenant_access_token 失败: ${json?.msg || "unknown error"}`);
    }
    const token = String(json?.tenant_access_token || "").trim();
    if (!token) {
      throw new Error("tenant_access_token 为空");
    }
    return {
      baseUrl,
      token,
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("获取 tenant_access_token 超时");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeLarkAction(actionInput) {
  const action = String(actionInput || "").trim().toLowerCase();
  if (!action) {
    throw new Error("action 不能为空");
  }
  const supportedActions = Object.keys(getLarkActionHandlers());
  if (!supportedActions.includes(action)) {
    throw new Error(`action 不支持: ${action}`);
  }
  return action;
}

function toIsoWithDefault(value, fallback) {
  const source = String(value || "").trim();
  if (!source) {
    return fallback.toISOString();
  }
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("时间格式不合法，请使用 ISO8601，例如 2026-03-27T00:00:00+08:00");
  }
  return parsed.toISOString();
}

function toLarkTimestampSeconds(value, fallback) {
  const iso = toIsoWithDefault(value, fallback);
  const millis = new Date(iso).getTime();
  return String(Math.floor(millis / 1000));
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function getDatePartsAtUtcOffset(date, offsetHours) {
  const offsetMs = Number(offsetHours) * 60 * 60 * 1000;
  const shifted = new Date(date.getTime() + offsetMs);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
  };
}

function formatIsoAtUtcOffset(isoValue, offsetHours) {
  const parsed = new Date(isoValue);
  if (Number.isNaN(parsed.getTime())) {
    return String(isoValue || "").trim();
  }
  const parts = getDatePartsAtUtcOffset(parsed, offsetHours);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)} ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

function getYyyyMmDdAtUtcOffset(date, offsetHours) {
  const parts = getDatePartsAtUtcOffset(date, offsetHours);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function getTodayRangeIso() {
  const beijingOffsetHours = 8;
  const now = new Date();
  const todayParts = getDatePartsAtUtcOffset(now, beijingOffsetHours);
  const startUtcMs = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day, 0, 0, 0, 0) - beijingOffsetHours * 60 * 60 * 1000;
  const endUtcMs = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day, 23, 59, 59, 999) - beijingOffsetHours * 60 * 60 * 1000;
  const start = new Date(startUtcMs);
  const end = new Date(endUtcMs);
  return {
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function formatLarkTime(value) {
  if (value && typeof value === "object") {
    const timestamp = String(value.timestamp || "").trim();
    const date = String(value.date || "").trim();
    if (timestamp) {
      return formatLarkTime(timestamp);
    }
    if (date) {
      return date;
    }
    return "";
  }
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }
  if (/^\d+$/.test(source)) {
    const numeric = Number(source);
    const millis = source.length >= 13 ? numeric : numeric * 1000;
    if (Number.isFinite(millis)) {
      return new Date(millis).toISOString();
    }
  }
  const parsed = new Date(source);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }
  return source;
}

function normalizeLarkCalendarPageSize(pageSizeInput, fallback = 50) {
  const parsed = Number(pageSizeInput);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const floored = Math.floor(parsed);
  if (floored < 50) {
    return 50;
  }
  if (floored > 200) {
    return 200;
  }
  return floored;
}

function normalizeMeeting(event) {
  const startTime = formatLarkTime(event?.start_time);
  const endTime = formatLarkTime(event?.end_time);
  const summary = String(event?.summary || "").trim() || "(无主题)";
  const meetingLinkCandidates = [
    event?.meeting_url,
    event?.join_url,
    event?.online_meeting_url,
    event?.vchat?.meeting_url,
    event?.vchat?.join_url,
    event?.vchat?.meeting_link,
    event?.video_conference?.url,
    event?.conference?.url,
  ];
  const meetingLink = meetingLinkCandidates
    .map((item) => String(item || "").trim())
    .find((item) => /^https?:\/\//i.test(item));
  return {
    eventId: String(event?.event_id || "").trim(),
    summary,
    status: String(event?.status || "").trim(),
    isAllDay: Boolean(event?.is_all_day),
    startTime,
    endTime,
    startTimeLocal: formatIsoAtUtcOffset(startTime, 8),
    endTimeLocal: formatIsoAtUtcOffset(endTime, 8),
    timezone: "Asia/Shanghai",
    meetingLink: meetingLink || "",
    description: String(event?.description || "").trim(),
    organizer: {
      id: String(event?.organizer?.id || "").trim(),
      idType: String(event?.organizer?.id_type || "").trim(),
      name: String(event?.organizer?.name || "").trim(),
    },
  };
}

async function listLarkChatsByOpenApi({ pageSize = 50, pageToken = "" } = {}) {
  const { baseUrl, token } = await getTenantAccessToken();
  const query = new URLSearchParams({
    page_size: String(pageSize),
  });
  const normalizedToken = String(pageToken || "").trim();
  if (normalizedToken) {
    query.set("page_token", normalizedToken);
  }
  const payload = await fetchLarkJson({
    url: `${baseUrl}/open-apis/im/v1/chats?${query.toString()}`,
    accessToken: token,
  });
  const items = Array.isArray(payload?.data?.items) ? payload.data.items : [];
  return {
    hasMore: Boolean(payload?.data?.has_more),
    pageToken: String(payload?.data?.page_token || "").trim(),
    chats: items.map((item) => ({
      chatId: String(item?.chat_id || "").trim(),
      name: String(item?.name || "").trim(),
      description: String(item?.description || "").trim(),
      avatar: String(item?.avatar || "").trim(),
      chatMode: String(item?.chat_mode || "").trim(),
      chatType: String(item?.chat_type || "").trim(),
    })),
  };
}

function isLikelyLarkChatId(value) {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return false;
  }
  return /^oc_[a-z0-9]+$/i.test(normalized) || /^chat_[a-z0-9]+$/i.test(normalized);
}

async function findLarkChatByName(chatName, maxPages = 5) {
  const target = String(chatName || "").trim();
  if (!target) {
    return null;
  }
  let nextToken = "";
  for (let index = 0; index < maxPages; index += 1) {
    const page = await listLarkChatsByOpenApi({
      pageSize: 100,
      pageToken: nextToken,
    });
    const chats = Array.isArray(page?.chats) ? page.chats : [];
    const exactMatch = chats.find((item) => String(item?.name || "").trim() === target);
    if (exactMatch?.chatId) {
      return exactMatch;
    }
    const fuzzyMatch = chats.find((item) => String(item?.name || "").trim().includes(target));
    if (fuzzyMatch?.chatId) {
      return fuzzyMatch;
    }
    if (!page?.hasMore) {
      break;
    }
    nextToken = String(page?.pageToken || "").trim();
    if (!nextToken) {
      break;
    }
  }
  return null;
}

function isLikelyInvalidReceiveIdError(errorLike) {
  const message = String(errorLike?.message || errorLike || "").toLowerCase();
  if (!message) {
    return false;
  }
  return (
    message.includes("invalid receive_id") ||
    message.includes("illegal receive_id") ||
    message.includes("chat_id not found") ||
    message.includes("400")
  );
}

async function listLarkCalendars({ pageSize = 50, pageToken = "" } = {}) {
  const { baseUrl, token } = await getLarkUserAuthConfig();
  const normalizedPageSize = normalizeLarkCalendarPageSize(pageSize, 50);
  const query = new URLSearchParams({
    page_size: String(normalizedPageSize),
  });
  const normalizedToken = String(pageToken || "").trim();
  if (normalizedToken) {
    query.set("page_token", normalizedToken);
  }
  const payload = await fetchLarkJson({
    url: `${baseUrl}/open-apis/calendar/v4/calendars?${query.toString()}`,
    accessToken: token,
  });
  const items = Array.isArray(payload?.data?.items)
    ? payload.data.items
    : Array.isArray(payload?.data?.calendar_list)
      ? payload.data.calendar_list
      : [];
  return {
    hasMore: Boolean(payload?.data?.has_more),
    pageToken: String(payload?.data?.page_token || "").trim(),
    calendars: items.map((item) => ({
      calendarId: String(item?.calendar_id || "").trim(),
      summary: String(item?.summary || "").trim(),
      description: String(item?.description || "").trim(),
      type: String(item?.type || "").trim(),
      isPrimary: Boolean(item?.is_primary),
    })),
  };
}

async function getLarkPrimaryCalendar() {
  const { baseUrl, token } = await getLarkUserAuthConfig();
  const payload = await fetchLarkJson({
    url: `${baseUrl}/open-apis/calendar/v4/calendars/primary`,
    accessToken: token,
  });
  const item = payload?.data?.calendar || payload?.data || {};
  const calendarId = String(item?.calendar_id || "").trim();
  if (!calendarId) {
    return null;
  }
  return {
    calendarId,
    summary: String(item?.summary || "").trim(),
    description: String(item?.description || "").trim(),
    type: String(item?.type || "").trim(),
    isPrimary: Boolean(item?.is_primary || true),
  };
}

async function listLarkCalendarEvents({ calendarId, startTime, endTime, pageSize = 100, pageToken = "" }) {
  const targetCalendarId = String(calendarId || "").trim();
  if (!targetCalendarId) {
    throw new Error("缺少 calendarId");
  }
  const { baseUrl, token } = await getLarkUserAuthConfig();
  const { startIso, endIso } = getTodayRangeIso();
  const normalizedPageSize = normalizeLarkCalendarPageSize(pageSize, 100);
  const query = new URLSearchParams({
    start_time: toLarkTimestampSeconds(startTime, new Date(startIso)),
    end_time: toLarkTimestampSeconds(endTime, new Date(endIso)),
    page_size: String(normalizedPageSize),
  });
  const normalizedToken = String(pageToken || "").trim();
  if (normalizedToken) {
    query.set("page_token", normalizedToken);
  }
  const payload = await fetchLarkJson({
    url: `${baseUrl}/open-apis/calendar/v4/calendars/${encodeURIComponent(targetCalendarId)}/events?${query.toString()}`,
    accessToken: token,
  });
  const items = Array.isArray(payload?.data?.items)
    ? payload.data.items
    : Array.isArray(payload?.data?.event_list)
      ? payload.data.event_list
      : [];
  return {
    hasMore: Boolean(payload?.data?.has_more),
    pageToken: String(payload?.data?.page_token || "").trim(),
    events: items.map(normalizeMeeting),
  };
}

async function listAllLarkCalendars({ pageSize = 50 } = {}) {
  const calendars = [];
  let nextToken = "";
  for (;;) {
    const page = await listLarkCalendars({
      pageSize,
      pageToken: nextToken,
    });
    calendars.push(...(Array.isArray(page?.calendars) ? page.calendars : []));
    if (!page?.hasMore) {
      break;
    }
    nextToken = String(page?.pageToken || "").trim();
    if (!nextToken) {
      break;
    }
  }
  return calendars;
}

async function listAllLarkCalendarEvents({
  calendarId,
  startTime,
  endTime,
  pageSize = 100,
} = {}) {
  const events = [];
  let nextToken = "";
  for (;;) {
    const page = await listLarkCalendarEvents({
      calendarId,
      startTime,
      endTime,
      pageSize,
      pageToken: nextToken,
    });
    events.push(...(Array.isArray(page?.events) ? page.events : []));
    if (!page?.hasMore) {
      break;
    }
    nextToken = String(page?.pageToken || "").trim();
    if (!nextToken) {
      break;
    }
  }
  return events;
}

async function summarizeTodayMeetings({ calendarId }) {
  let targetCalendarId = String(calendarId || "").trim();
  const allCalendars = await listAllLarkCalendars({ pageSize: 50 });
  if (!allCalendars.length) {
    throw new Error("未获取到可用日历，请检查日历权限");
  }
  const primaryCalendar = allCalendars.find((item) => item.isPrimary) || allCalendars[0];
  if (!targetCalendarId) {
    targetCalendarId = String(primaryCalendar?.calendarId || "").trim();
  }
  const calendarsToScan = targetCalendarId
    ? allCalendars.filter((item) => String(item?.calendarId || "").trim() === targetCalendarId)
    : allCalendars;
  const validCalendars = calendarsToScan.length ? calendarsToScan : allCalendars;
  const calendarNameById = new Map(
    validCalendars.map((item) => [String(item?.calendarId || "").trim(), String(item?.summary || "").trim()])
  );
  const eventPages = await Promise.all(
    validCalendars.map(async (item) => {
      const id = String(item?.calendarId || "").trim();
      const events = await listAllLarkCalendarEvents({ calendarId: id, pageSize: 100 });
      return events.map((event) => ({
        ...event,
        calendarId: id,
        calendarSummary: calendarNameById.get(id) || "",
      }));
    })
  );
  const eventMap = new Map();
  for (const pageEvents of eventPages) {
    for (const item of pageEvents) {
      if (item.status === "cancelled") {
        continue;
      }
      const dedupeKey =
        String(item.eventId || "").trim() ||
        `${String(item.calendarId || "").trim()}|${String(item.startTime || "").trim()}|${String(item.summary || "").trim()}`;
      if (!eventMap.has(dedupeKey)) {
        eventMap.set(dedupeKey, item);
      }
    }
  }
  const meetings = [...eventMap.values()].sort((a, b) =>
    String(a.startTime).localeCompare(String(b.startTime))
  );
  return {
    calendarId: targetCalendarId,
    date: getYyyyMmDdAtUtcOffset(new Date(), 8),
    timezone: "Asia/Shanghai",
    count: meetings.length,
    scannedCalendarCount: validCalendars.length,
    meetings,
  };
}

async function createLarkCalendarEvent({
  calendarId,
  summary,
  startTime,
  endTime,
  description,
  visibility,
  preferPrimary,
} = {}) {
  let targetCalendarId = String(calendarId || "").trim();
  let targetCalendarMeta = null;
  if (!targetCalendarId) {
    const calendars = await listAllLarkCalendars({ pageSize: 50 });
    if (!calendars.length) {
      throw new Error("未获取到可用日历，请检查日历权限");
    }
    const shouldPreferPrimary = preferPrimary !== false;
    if (shouldPreferPrimary) {
      try {
        const primaryCalendar = await getLarkPrimaryCalendar();
        if (primaryCalendar?.calendarId) {
          targetCalendarId = primaryCalendar.calendarId;
          targetCalendarMeta = primaryCalendar;
        }
      } catch (_) {}
    }
    if (!targetCalendarId) {
      const primary = calendars.find((item) => item.isPrimary) || calendars[0];
      targetCalendarId = String(primary?.calendarId || "").trim();
      targetCalendarMeta = primary || null;
    }
  }
  if (!targetCalendarId) {
    throw new Error("缺少 calendarId");
  }
  if (!targetCalendarMeta) {
    const calendars = await listAllLarkCalendars({ pageSize: 50 });
    targetCalendarMeta =
      calendars.find((item) => String(item?.calendarId || "").trim() === targetCalendarId) || null;
  }
  const title = String(summary || "").trim() || "(无主题)";
  const now = new Date();
  const fallbackStart = new Date(now.getTime() + 5 * 60 * 1000);
  const fallbackEnd = new Date(fallbackStart.getTime() + 30 * 60 * 1000);
  const startSeconds = Number(toLarkTimestampSeconds(startTime, fallbackStart));
  const endSeconds = Number(toLarkTimestampSeconds(endTime, fallbackEnd));
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || endSeconds <= startSeconds) {
    throw new Error("会议时间不合法，endTime 必须晚于 startTime");
  }
  const userAuth = await getLarkUserAuthConfig();
  const baseUrlToUse = userAuth.baseUrl;
  const tokenToUse = userAuth.token;
  const body = {
    summary: title,
    start_time: {
      timestamp: String(startSeconds),
      timezone: "Asia/Shanghai",
    },
    end_time: {
      timestamp: String(endSeconds),
      timezone: "Asia/Shanghai",
    },
    vchat: {
      vc_type: "vc",
      meeting_settings: {
        join_meeting_permission: "anyone_can_join",
      },
    },
  };
  const normalizedDescription = String(description || "").trim();
  if (normalizedDescription) {
    body.description = normalizedDescription;
  }
  const normalizedVisibility = String(visibility || "").trim();
  if (normalizedVisibility) {
    body.visibility = normalizedVisibility;
  }
  const payload = await fetchLarkJson({
    url: `${baseUrlToUse}/open-apis/calendar/v4/calendars/${encodeURIComponent(targetCalendarId)}/events`,
    method: "POST",
    body,
    accessToken: tokenToUse,
  });
  const rawEvent = payload?.data?.event || payload?.data || {};
  const normalizedEvent = normalizeMeeting(rawEvent);
  return {
    calendarId: targetCalendarId,
    calendarSummary: String(targetCalendarMeta?.summary || "").trim(),
    calendarType: String(targetCalendarMeta?.type || "").trim(),
    event: {
      ...normalizedEvent,
      summary: normalizedEvent.summary || title,
    },
    raw: payload?.data || {},
  };
}

async function sendByAppApi({ messageText, chatId }) {
  const inputChat = String(chatId || "").trim();
  if (!inputChat) {
    throw new Error("缺少 chat_id，请传入 chatId");
  }
  let targetChatId = inputChat;
  let resolvedByName = false;
  if (!isLikelyLarkChatId(targetChatId)) {
    const matchedChat = await findLarkChatByName(targetChatId);
    if (matchedChat?.chatId) {
      targetChatId = matchedChat.chatId;
      resolvedByName = true;
    }
  }
  const client = createLarkApiClient();
  if (!client) {
    throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
  }

  let response = null;
  try {
    response = await client.im.message.create({
      params: {
        receive_id_type: "chat_id",
      },
      data: {
        receive_id: targetChatId,
        msg_type: "text",
        content: JSON.stringify({ text: messageText }),
      },
    });
  } catch (error) {
    if (!resolvedByName && isLikelyInvalidReceiveIdError(error) && !isLikelyLarkChatId(inputChat)) {
      const fallbackChat = await findLarkChatByName(inputChat);
      if (fallbackChat?.chatId) {
        targetChatId = fallbackChat.chatId;
        resolvedByName = true;
        response = await client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: targetChatId,
            msg_type: "text",
            content: JSON.stringify({ text: messageText }),
          },
        });
      } else {
        throw error;
      }
    } else {
      throw error;
    }
  }

  if (Number(response?.code || 0) !== 0) {
    if (!resolvedByName && !isLikelyLarkChatId(inputChat) && isLikelyInvalidReceiveIdError(response?.msg)) {
      const fallbackChat = await findLarkChatByName(inputChat);
      if (fallbackChat?.chatId) {
        const retryResponse = await client.im.message.create({
          params: {
            receive_id_type: "chat_id",
          },
          data: {
            receive_id: fallbackChat.chatId,
            msg_type: "text",
            content: JSON.stringify({ text: messageText }),
          },
        });
        if (Number(retryResponse?.code || 0) === 0) {
          return {
            channel: "app_api",
            chatId: fallbackChat.chatId,
            resolvedFrom: inputChat,
            messageLength: messageText.length,
            platformResponse: retryResponse,
          };
        }
      }
    }
    throw new Error(`飞书消息发送失败: ${response?.msg || "unknown error"}`);
  }

  return {
    channel: "app_api",
    chatId: targetChatId,
    resolvedFrom: resolvedByName ? inputChat : "",
    messageLength: messageText.length,
    platformResponse: response,
  };
}

function normalizeReceiveIdType(receiveIdTypeInput) {
  const type = String(receiveIdTypeInput || "").trim().toLowerCase();
  const allowed = new Set(["chat_id", "open_id", "user_id", "email", "union_id"]);
  if (!allowed.has(type)) {
    throw new Error("receiveIdType 不合法，可选值: chat_id | open_id | user_id | email | union_id");
  }
  return type;
}

function normalizeLarkMentions(textInput) {
  const text = String(textInput || "");
  if (!text.trim()) {
    return "";
  }
  if (/<at\s+user_id\s*=\s*"all"\s*>/i.test(text)) {
    return text;
  }
  return text.replace(
    /(^|[\s(（\[【'"“‘,，.。!！?？:：;；])[@＠](?:所有人|all)(?=($|[\s,，.。!！?？:：;；)\]】'"”’]))/gi,
    (_, prefix) => `${prefix}<at user_id="all">所有人</at>`
  );
}

function readLarkReceiverCache() {
  try {
    if (!fs.existsSync(LARK_RECEIVER_CACHE_FILE)) {
      return null;
    }
    const raw = fs.readFileSync(LARK_RECEIVER_CACHE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    const receiveIdType = normalizeReceiveIdType(parsed?.receiveIdType);
    const receiveId = String(parsed?.receiveId || "").trim();
    if (!receiveId) {
      return null;
    }
    return {
      receiveIdType,
      receiveId,
    };
  } catch (_) {
    return null;
  }
}

async function sendByAppApiWithReceiveId({ messageText, receiveIdType, receiveId }) {
  const targetReceiveId = String(receiveId || "").trim();
  if (!targetReceiveId) {
    throw new Error("缺少 receiveId");
  }
  const normalizedType = normalizeReceiveIdType(receiveIdType);
  const client = createLarkApiClient();
  if (!client) {
    throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
  }

  const response = await client.im.message.create({
    params: {
      receive_id_type: normalizedType,
    },
    data: {
      receive_id: targetReceiveId,
      msg_type: "text",
      content: JSON.stringify({ text: messageText }),
    },
  });

  if (Number(response?.code || 0) !== 0) {
    throw new Error(`飞书消息发送失败: ${response?.msg || "unknown error"}`);
  }

  return {
    channel: "app_api",
    receiveIdType: normalizedType,
    receiveId: targetReceiveId,
    messageLength: messageText.length,
    platformResponse: response,
  };
}

async function sendLarkMessage({ text, chatId, receiveIdType, receiveId }) {
  const messageText = String(text || "").trim();
  if (!messageText) {
    throw new Error("text 不能为空");
  }
  const normalizedMessageText = normalizeLarkMentions(messageText);

  if (String(chatId || "").trim()) {
    return sendByAppApi({
      messageText: normalizedMessageText,
      chatId,
    });
  }

  if (String(receiveId || "").trim() && String(receiveIdType || "").trim()) {
    return sendByAppApiWithReceiveId({
      messageText: normalizedMessageText,
      receiveIdType,
      receiveId,
    });
  }

  const oauthTokenCache = readLarkUserTokenCache();
  const oauthOpenId = String(oauthTokenCache?.openId || "").trim();
  if (oauthOpenId) {
    return sendByAppApiWithReceiveId({
      messageText: normalizedMessageText,
      receiveIdType: "open_id",
      receiveId: oauthOpenId,
    });
  }

  const allowCachedGroupFallback =
    String(process.env.LARK_ALLOW_CACHED_GROUP_FALLBACK || "false").trim().toLowerCase() === "true";
  const cachedReceiver = readLarkReceiverCache();
  if (allowCachedGroupFallback && cachedReceiver) {
    return sendByAppApiWithReceiveId({
      messageText: normalizedMessageText,
      receiveIdType: cachedReceiver.receiveIdType,
      receiveId: cachedReceiver.receiveId,
    });
  }

  throw new Error(
    "未指定消息接收方。请传入 receiveIdType+receiveId 或 chatId；若要默认直发机器人，请先完成 OAuth 以获取用户 open_id"
  );
}

function getLarkActionHandlers() {
  return {
    send_message: {
      execute: async (input = {}) =>
        sendLarkMessage({
          text: input?.text,
          chatId: input?.chatId,
          receiveIdType: input?.receiveIdType,
          receiveId: input?.receiveId,
        }),
      probe: async () => {
        const client = createLarkApiClient();
        if (!client) {
          throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
        }
      },
    },
    list_chats: {
      execute: async (input = {}) =>
        listLarkChatsByOpenApi({
          pageSize: input?.pageSize,
          pageToken: input?.pageToken,
        }),
      probe: async () => {
        await listLarkChatsByOpenApi({ pageSize: 1 });
      },
    },
    list_calendars: {
      execute: async (input = {}) =>
        listLarkCalendars({
          pageSize: input?.pageSize,
          pageToken: input?.pageToken,
        }),
      probe: async () => {
        await listLarkCalendars({ pageSize: 50 });
      },
    },
    list_calendar_events: {
      execute: async (input = {}) =>
        listLarkCalendarEvents({
          calendarId: input?.calendarId,
          startTime: input?.startTime,
          endTime: input?.endTime,
          pageSize: input?.pageSize,
          pageToken: input?.pageToken,
        }),
      probe: async () => {
        const calendars = await listLarkCalendars({ pageSize: 50 });
        const calendarId = String(calendars?.calendars?.[0]?.calendarId || "").trim();
        if (!calendarId) {
          throw new Error("未找到可访问日历");
        }
        await listLarkCalendarEvents({ calendarId, pageSize: 50 });
      },
    },
    summarize_today_meetings: {
      execute: async (input = {}) =>
        summarizeTodayMeetings({
          calendarId: input?.calendarId,
        }),
      probe: async () => {
        await summarizeTodayMeetings({});
      },
    },
    create_calendar_event: {
      execute: async (input = {}) =>
        createLarkCalendarEvent({
          calendarId: input?.calendarId,
          summary: input?.summary,
          startTime: input?.startTime,
          endTime: input?.endTime,
          description: input?.description,
          visibility: input?.visibility,
          preferPrimary: input?.preferPrimary,
        }),
      probe: async () => {
        const calendars = await listLarkCalendars({ pageSize: 1 });
        const calendarId = String(calendars?.calendars?.[0]?.calendarId || "").trim();
        if (!calendarId) {
          throw new Error("未找到可访问日历");
        }
      },
    },
  };
}

async function probeCapability(fn) {
  try {
    await withLarkReauthHint(async () => {
      await fn();
    });
    return { enabled: true, reason: "" };
  } catch (error) {
    return {
      enabled: false,
      reason: String(error?.message || error || "unknown error").slice(0, 500),
    };
  }
}

async function detectLarkActionAvailability() {
  const handlers = getLarkActionHandlers();
  const results = {};
  for (const [action, definition] of Object.entries(handlers)) {
    const probeFn =
      typeof definition?.probe === "function"
        ? definition.probe
        : async () => {
            await definition.execute({});
          };
    results[action] = await probeCapability(probeFn);
  }
  return results;
}

async function runLarkWorkspaceAction(input = {}) {
  const action = normalizeLarkAction(input?.action);
  const handlers = getLarkActionHandlers();
  const handler = handlers[action];
  return withLarkReauthHint(async () => handler.execute(input));
}

async function getWorkspaceCapabilities() {
  const availability = await detectLarkActionAvailability();
  const actions = Object.entries(availability).map(([name, status]) => ({
    name,
    enabled: Boolean(status?.enabled),
    reason: String(status?.reason || ""),
  }));
  return {
    providers: [
      {
        provider: "lark",
        displayName: "Lark/Feishu",
        actions,
      },
    ],
  };
}

function normalizeWorkspaceProvider(providerInput) {
  const provider = String(providerInput || "").trim().toLowerCase();
  if (!provider) {
    throw new Error("provider 不能为空");
  }
  return provider;
}

async function runWorkspaceAction({ provider, action, input }) {
  const normalizedProvider = normalizeWorkspaceProvider(provider);
  if (normalizedProvider === "lark") {
    return runLarkWorkspaceAction({
      ...(input && typeof input === "object" ? input : {}),
      action,
    });
  }
  throw new Error(`暂不支持 provider: ${normalizedProvider}，请先接入对应 Provider Adapter`);
}

module.exports = {
  getClicktagInfo,
  getWeatherInfo,
  getAStockHistory,
  sendLarkMessage,
  getLarkOAuthAuthorizeUrl,
  exchangeLarkUserAccessTokenByCode,
  getLarkOAuthTokenStatus,
  runLarkWorkspaceAction,
  runWorkspaceAction,
  getWorkspaceCapabilities,
};
