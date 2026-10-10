// script.js - Universal Weather Coordinator & Lockscreen UI (Full UI Customization)
'use strict';

let API_KEY = '';
let CITY_NAME = '';
let LATITUDE = 58.1983;
let LONGITUDE = 68.2547;

let OWM_ENABLED = false;
let STATIC_TIME_ENABLED = true;
let MANUAL_TIME_HOURS = 14;
let MANUAL_TIME_MINUTES = 30;

let CONFIG = {
    windMult: 1.0,
    precipDensity: 1.0,
    qualityScale: 1.0,
    showVignette: true
};

// Видимость элементов интерфейса
let UI_VISIBILITY = {
    time: true,
    date: true,
    temp: true,
    desc: true,
    city: true
};

const state = {
    cloudCoverage: 0.40,
    targetCloudCoverage: 0.40,
    cloudDensity: 0.70,
    targetCloudDensity: 0.70,
    cloudType: 0.0,
    targetCloudType: 0.0,

    rain: 0.0,
    targetRain: 0.0,
    heavyRain: 0.0,
    targetHeavyRain: 0.0,
    drizzle: 0.0,
    targetDrizzle: 0.0,
    snow: 0.0,
    targetSnow: 0.0,
    blizzard: 0.0,
    targetBlizzard: 0.0,
    dust: 0.0,
    targetDust: 0.0,
    fog: 0.0,
    targetFog: 0.0,
    thunder: 0.0,
    targetThunder: 0.0,

    windSpeed: 4.0,
    windAngle: 45.0,
    windVec: [0.03, 0.0],
    showVignette: true,
    temp: 20.0
};

let owmSunrise = 0;
let owmSunset = 0;
let lightningTimer = 4.0;
let lightningVal = 0.0;
let lastWeatherUpdate = 0;
const WEATHER_UPDATE_INTERVAL = 10 * 60 * 1000;

const elDate = document.getElementById('current-date');
const elTime = document.getElementById('current-time');
const elTemp = document.getElementById('current-temp');
const elDesc = document.getElementById('current-weather-description');
const elCity = document.getElementById('current-city');
const elSeparator = document.getElementById('weather-separator');

// ==========================================
// 1. УПРАВЛЕНИЕ ВИДИМОСТЬЮ ИНТЕРФЕЙСА
// ==========================================
function updateUIVisibility() {
    if (elTime) elTime.style.display = UI_VISIBILITY.time ? '' : 'none';
    if (elDate) elDate.style.display = UI_VISIBILITY.date ? '' : 'none';
    if (elTemp) elTemp.style.display = UI_VISIBILITY.temp ? '' : 'none';
    if (elDesc) elDesc.style.display = UI_VISIBILITY.desc ? '' : 'none';
    if (elCity) elCity.style.display = UI_VISIBILITY.city ? '' : 'none';

    // Разделитель показывается только если активны и температура, и описание
    if (elSeparator) {
        elSeparator.style.display = (UI_VISIBILITY.temp && UI_VISIBILITY.desc) ? '' : 'none';
    }
}

// ==========================================
// 2. РАСЧЕТ ПОЛОЖЕНИЯ СОЛНЦА И ЛУНЫ
// ==========================================
class CelestialCalculator {
    static calculate(date, lat, lon, aspect, sunriseUnix, sunsetUnix) {
        let sunAlt = 0.0;
        let sunAz = Math.PI;

        if (STATIC_TIME_ENABLED) {
            const fraction = (MANUAL_TIME_HOURS + MANUAL_TIME_MINUTES / 60.0) / 24.0;
            sunAlt = Math.sin((fraction - 0.25) * 2.0 * Math.PI) * 1.15;
            sunAz = fraction * 2.0 * Math.PI;
        } else if (sunriseUnix > 0 && sunsetUnix > 0 && sunsetUnix > sunriseUnix) {
            const nowSec = Math.floor(date.getTime() / 1000.0);
            const dayLength = sunsetUnix - sunriseUnix;
            const nightLength = 86400.0 - dayLength;
            const maxElevation = Math.max(0.45, Math.min(1.25, (90.0 - Math.abs(lat) + 15.0) * (Math.PI / 180.0)));

            if (nowSec >= sunriseUnix && nowSec < sunsetUnix) {
                const dayProgress = (nowSec - sunriseUnix) / dayLength;
                sunAlt = Math.sin(dayProgress * Math.PI) * maxElevation;
                sunAz = (75.0 + dayProgress * 210.0) * (Math.PI / 180.0);
            } else {
                let nightProgress = 0.0;
                if (nowSec >= sunsetUnix) {
                    nightProgress = (nowSec - sunsetUnix) / nightLength;
                } else {
                    nightProgress = (nowSec + 86400.0 - sunsetUnix) / nightLength;
                }
                nightProgress = Math.max(0.0, Math.min(1.0, nightProgress));
                sunAlt = -Math.sin(nightProgress * Math.PI) * maxElevation;
                sunAz = (285.0 + nightProgress * 150.0) * (Math.PI / 180.0);
            }
        } else {
            const fraction = (date.getHours() + date.getMinutes() / 60.0) / 24.0;
            sunAlt = Math.sin((fraction - 0.25) * 2.0 * Math.PI) * 1.15;
            sunAz = fraction * 2.0 * Math.PI;
        }

        const sunUV = [
            Math.sin(sunAz) * 0.5 + 0.5,
            Math.max(-0.25, (sunAlt / (Math.PI * 0.5)) * 0.75 + 0.25)
        ];

        const moonAlt = -sunAlt;
        const moonAz = (sunAz + Math.PI) % (2.0 * Math.PI);
        const moonUV = [
            Math.sin(moonAz) * 0.5 + 0.5,
            Math.max(-0.25, (moonAlt / (Math.PI * 0.5)) * 0.75 + 0.25)
        ];

        return { sunAlt, sunUV, moonAlt, moonUV };
    }
}

// ==========================================
// 3. РАСЧЕТ РУЧНЫХ ПАРАМЕТРОВ
// ==========================================
function updateManualWeather() {
    if (OWM_ENABLED) return;

    let description = 'Ясно';
    if (state.targetThunder > 0.5) {
        description = 'Гроза';
    } else if (state.targetSnow > 0.1) {
        description = state.targetSnow > 5.0 ? 'Метель' : 'Снегопад';
    } else if (state.targetRain > 0.1) {
        description = state.targetRain > 5.0 ? 'Ливень' : 'Дождь';
    } else if (state.targetFog > 0.4) {
        description = 'Туман';
    } else if (state.targetCloudCoverage > 0.85) {
        description = 'Пасмурно';
    } else if (state.targetCloudCoverage > 0.45) {
        description = 'Облачно';
    } else if (state.targetCloudCoverage > 0.15) {
        description = 'Малооблачно';
    }

    if (elDesc) elDesc.textContent = description;
    if (elCity) elCity.textContent = CITY_NAME;
}

// ==========================================
// 4. СИНХРОНИЗАЦИЯ С OPENWEATHERMAP
// ==========================================
function parseOpenWeatherData(data) {
    if (!data || !OWM_ENABLED) return;

    if (data.coord) {
        LATITUDE = data.coord.lat;
        LONGITUDE = data.coord.lon;
    }
    if (data.sys && data.sys.sunrise && data.sys.sunset) {
        owmSunrise = data.sys.sunrise;
        owmSunset = data.sys.sunset;
    }

    const cloudAll = data.clouds?.all ?? 40;
    const windSpeed = data.wind?.speed ?? 4.0;
    const windDeg = data.wind?.deg ?? 45;
    const temp = Math.round(data.main?.temp ?? 15);
    const weatherId = data.weather?.[0]?.id ?? 800;

    state.targetCloudCoverage = cloudAll / 100.0;
    state.targetCloudDensity = Math.min(1.0, 0.4 + state.targetCloudCoverage * 0.6);
    state.targetCloudType = state.targetCloudCoverage > 0.8 ? 1.0 : 0.0;

    let rainVal = 0.0;
    let heavyVal = 0.0;
    let snowVal = 0.0;
    let thunderVal = (weatherId >= 200 && weatherId <= 232) ? 1.0 : 0.0;
    let fogVal = (weatherId >= 701 && weatherId <= 781) ? 0.85 : 0.0;

    if (weatherId >= 300 && weatherId <= 531) {
        rainVal = 0.85;
        if (weatherId >= 502 && weatherId <= 504) heavyVal = 1.0;
        state.targetCloudType = 1.0;
    } else if (weatherId >= 600 && weatherId <= 622) {
        snowVal = (weatherId === 602 || weatherId === 622) ? 1.0 : 0.85;
        state.targetCloudType = 0.75;
    }

    state.targetRain = rainVal * CONFIG.precipDensity;
    state.targetHeavyRain = heavyVal * CONFIG.precipDensity;
    state.targetSnow = snowVal * CONFIG.precipDensity;
    state.targetThunder = thunderVal;
    state.targetFog = fogVal;

    state.windSpeed = windSpeed;
    state.windAngle = windDeg;
    state.temp = temp;

    if (elCity) elCity.textContent = data.name || CITY_NAME;
    if (elTemp) elTemp.textContent = `${temp > 0 ? '+' : ''}${temp}°`;
    if (elDesc && data.weather?.[0]) {
        const desc = data.weather[0].description;
        elDesc.textContent = desc.charAt(0).toUpperCase() + desc.slice(1);
    }
}

async function fetchWeather() {
    if (!OWM_ENABLED || !API_KEY || !CITY_NAME) return;

    const weatherUrl = `https://api.openweathermap.org/data/2.5/weather?q=${CITY_NAME}&appid=${API_KEY}&units=metric&lang=ru`;
    try {
        const res = await fetch(weatherUrl);
        if (!res.ok) return;
        const data = await res.json();
        parseOpenWeatherData(data);
        lastWeatherUpdate = Date.now();
    } catch (err) {
        console.warn('Ошибка получения погоды OWM:', err);
    }
}

// ==========================================
// 5. СИСТЕМНЫЕ ЧАСЫ (АВТОНОМНО)
// ==========================================
function updateClock() {
    const now = new Date();
    const h = String(now.getHours()).padStart(2, '0');
    const m = String(now.getMinutes()).padStart(2, '0');
    if (elTime) elTime.textContent = `${h}:${m}`;

    if (elDate) {
        const options = { weekday: 'long', month: 'long', day: 'numeric' };
        const dateStr = now.toLocaleDateString('ru-RU', options);
        elDate.textContent = dateStr.charAt(0).toUpperCase() + dateStr.slice(1);
    }
}

// ==========================================
// 6. СЛУШАТЕЛЬ WALLPAPER ENGINE
// ==========================================
window.wallpaperPropertyListener = {
    applyUserProperties: function(props) {
        if (props.owm_enabled) {
            OWM_ENABLED = props.owm_enabled.value;
            if (OWM_ENABLED) fetchWeather();
            else updateManualWeather();
        }
        if (props.cityname) {
            CITY_NAME = props.cityname.value.trim();
            if (elCity) elCity.textContent = CITY_NAME;
            if (OWM_ENABLED) fetchWeather();
        }
        if (props.apikey) {
            API_KEY = props.apikey.value.trim();
            if (OWM_ENABLED) fetchWeather();
        }
        if (props.static_time_enabled) {
            STATIC_TIME_ENABLED = props.static_time_enabled.value;
        }
        if (props.manual_time_hours) {
            MANUAL_TIME_HOURS = props.manual_time_hours.value;
        }
        if (props.manual_time_minutes) {
            MANUAL_TIME_MINUTES = props.manual_time_minutes.value;
        }

        // Ручные ползунки погоды
        if (props.manual_clouds && !OWM_ENABLED) {
            state.targetCloudCoverage = props.manual_clouds.value / 100.0;
            state.targetCloudDensity = Math.min(1.0, 0.4 + state.targetCloudCoverage * 0.6);
            state.targetCloudType = state.targetCloudCoverage > 0.8 ? 1.0 : 0.0;
            updateManualWeather();
        }
        if (props.manual_wind && !OWM_ENABLED) {
            state.windSpeed = props.manual_wind.value;
        }
        if (props.manual_rain && !OWM_ENABLED) {
            const rainRate = props.manual_rain.value;
            state.targetRain = Math.min(1.0, rainRate / 6.0) * CONFIG.precipDensity;
            state.targetHeavyRain = Math.max(0.0, (rainRate - 5.0) / 10.0) * CONFIG.precipDensity;
            if (rainRate > 0.1) state.targetCloudType = 1.0;
            updateManualWeather();
        }
        if (props.manual_snow && !OWM_ENABLED) {
            const snowRate = props.manual_snow.value;
            state.targetSnow = Math.min(1.0, snowRate / 5.0) * CONFIG.precipDensity;
            state.targetBlizzard = Math.max(0.0, (snowRate - 6.0) / 8.0) * CONFIG.precipDensity;
            if (snowRate > 0.1) state.targetCloudType = 0.75;
            updateManualWeather();
        }
        if (props.manual_thunder && !OWM_ENABLED) {
            state.targetThunder = props.manual_thunder.value ? 1.0 : 0.0;
            if (props.manual_thunder.value) state.targetCloudType = 1.0;
            updateManualWeather();
        }
        if (props.manual_fog && !OWM_ENABLED) {
            state.targetFog = props.manual_fog.value / 100.0;
            updateManualWeather();
        }

        // Чекбоксы кастомизации элементов UI
        if (props.ui_show_time) UI_VISIBILITY.time = props.ui_show_time.value;
        if (props.ui_show_date) UI_VISIBILITY.date = props.ui_show_date.value;
        if (props.ui_show_temp) UI_VISIBILITY.temp = props.ui_show_temp.value;
        if (props.ui_show_desc) UI_VISIBILITY.desc = props.ui_show_desc.value;
        if (props.ui_show_city) UI_VISIBILITY.city = props.ui_show_city.value;
        updateUIVisibility();

        // Общие настройки рендера
        if (props.qualityscale) {
            CONFIG.qualityScale = props.qualityscale.value / 100.0;
            if (weatherEngine) weatherEngine.resize(CONFIG.qualityScale);
        }
        if (props.showvignette) {
            state.showVignette = props.showvignette.value;
        }

        if (props.weather && OWM_ENABLED) {
            try {
                const data = JSON.parse(props.weather.value);
                parseOpenWeatherData(data);
            } catch (e) {
                console.error(e);
            }
        }
    }
};

// ==========================================
// 7. ИНИЦИАЛИЗАЦИЯ И РЕНДЕР-ЦИКЛ
// ==========================================
const canvas = document.getElementById('gl-canvas');
const weatherEngine = new WeatherShaderEngine(canvas);

updateClock();
setInterval(updateClock, 1000);
updateManualWeather();
updateUIVisibility();

let lastTime = performance.now();

function mainLoop(timestamp) {
    const dt = Math.min((timestamp - lastTime) * 0.001, 0.1);
    lastTime = timestamp;

    if (OWM_ENABLED && Date.now() - lastWeatherUpdate > WEATHER_UPDATE_INTERVAL) {
        fetchWeather();
    }

    const wRad = state.windAngle * (Math.PI / 180.0);
    const wSpeed = state.windSpeed * 0.08;
    state.windVec = [Math.cos(wRad) * wSpeed, Math.sin(wRad) * wSpeed];

    const lerp = 0.035;
    state.cloudCoverage += (state.targetCloudCoverage - state.cloudCoverage) * lerp;
    state.cloudDensity += (state.targetCloudDensity - state.cloudDensity) * lerp;
    state.cloudType += (state.targetCloudType - state.cloudType) * lerp;

    state.rain += (state.targetRain - state.rain) * lerp;
    state.heavyRain += (state.targetHeavyRain - state.heavyRain) * lerp;
    state.snow += (state.targetSnow - state.snow) * lerp;
    state.blizzard += (state.targetBlizzard - state.blizzard) * lerp;
    state.fog += (state.targetFog - state.fog) * lerp;
    state.thunder += (state.targetThunder - state.thunder) * lerp;

    if (state.targetThunder > 0.1) {
        lightningTimer -= dt;
        if (lightningTimer <= 0) {
            lightningVal = 1.0;
            lightningTimer = 3.0 + Math.random() * 8.0;
        }
    }
    if (lightningVal > 0.0) {
        lightningVal -= dt * 4.5;
        if (lightningVal < 0.0) lightningVal = 0.0;
    }

    weatherEngine.resize(CONFIG.qualityScale);

    const now = new Date();
    const aspect = canvas.width / canvas.height;
    const celestial = CelestialCalculator.calculate(now, LATITUDE, LONGITUDE, aspect, owmSunrise, owmSunset);

    weatherEngine.render(timestamp * 0.001, state, celestial, lightningVal);

    requestAnimationFrame(mainLoop);
}

requestAnimationFrame(mainLoop);