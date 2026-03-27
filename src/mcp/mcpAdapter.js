const fs = require("fs");
const path = require("path");
const Lark = require("@larksuiteoapi/node-sdk");
const LARK_RECEIVER_CACHE_FILE = path.resolve(process.cwd(), ".lark-receiver-cache.json");

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

function normalizeLarkAppType(appTypeInput) {
  const normalized = String(appTypeInput || "self_build").trim().toLowerCase();
  if (normalized === "marketplace") {
    return Lark.AppType.Marketplace;
  }
  return Lark.AppType.SelfBuild;
}

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

async function sendByAppApi({ messageText, chatId }) {
  const targetChatId = String(chatId || "").trim();
  if (!targetChatId) {
    throw new Error("缺少 chat_id，请传入 chatId");
  }
  const client = createLarkApiClient();
  if (!client) {
    throw new Error("缺少 LARK_APP_ID 或 LARK_APP_SECRET");
  }

  const response = await client.im.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: targetChatId,
      msg_type: "text",
      content: JSON.stringify({ text: messageText }),
    },
  });

  if (Number(response?.code || 0) !== 0) {
    throw new Error(`飞书消息发送失败: ${response?.msg || "unknown error"}`);
  }

  return {
    channel: "app_api",
    chatId: targetChatId,
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

  if (String(chatId || "").trim()) {
    return sendByAppApi({
      messageText,
      chatId,
    });
  }

  if (String(receiveId || "").trim() && String(receiveIdType || "").trim()) {
    return sendByAppApiWithReceiveId({
      messageText,
      receiveIdType,
      receiveId,
    });
  }

  const cachedReceiver = readLarkReceiverCache();
  if (cachedReceiver) {
    return sendByAppApiWithReceiveId({
      messageText,
      receiveIdType: cachedReceiver.receiveIdType,
      receiveId: cachedReceiver.receiveId,
    });
  }

  return sendByAppApiWithReceiveId({
    messageText,
    receiveIdType,
    receiveId,
  });
}

module.exports = { getClicktagInfo, getWeatherInfo, getAStockHistory, sendLarkMessage };
