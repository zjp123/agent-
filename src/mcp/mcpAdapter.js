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

module.exports = { getClicktagInfo, getWeatherInfo };
