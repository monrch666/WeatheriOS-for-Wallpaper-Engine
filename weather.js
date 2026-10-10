// weather.js - True 3D Volumetric Atmosphere & Universal Weather Engine (Polished Optics)
'use strict';

class WeatherShaderEngine {
    constructor(canvas) {
        this.canvas = canvas;
        this.qualityScale = 1.0;
        this.lightningSeed = 0.5;

        this.renderer = new THREE.WebGLRenderer({
            canvas: this.canvas,
            alpha: false,
            antialias: false,
            powerPreference: 'high-performance'
        });

        this.scene = new THREE.Scene();
        this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

        this.initNoiseTexture();
        this.initMaterial();

        const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
        this.scene.add(quad);
    }

    initNoiseTexture() {
        const size = 256;
        const data = new Uint8Array(size * size * 4);
        for (let i = 0; i < size * size * 4; i++) {
            data[i] = Math.floor(Math.random() * 256);
        }
        this.noiseTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
        this.noiseTexture.wrapS = THREE.RepeatWrapping;
        this.noiseTexture.wrapT = THREE.RepeatWrapping;
        this.noiseTexture.minFilter = THREE.LinearFilter;
        this.noiseTexture.magFilter = THREE.LinearFilter;
        this.noiseTexture.needsUpdate = true;
    }

    initMaterial() {
        const vertexShader = `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = vec4(position, 1.0);
            }
        `;

        const fragmentShader = `
            precision highp float;

            varying vec2 vUv;

            uniform vec2  u_resolution;
            uniform float u_time;
            uniform vec2  u_sun_uv;
            uniform float u_sun_alt;
            uniform vec2  u_moon_uv;
            uniform float u_moon_alt;
            uniform float u_moon_phase;
            uniform vec2  u_wind;

            uniform float u_cloud_cov;
            uniform float u_cloud_density;
            uniform float u_cloud_type;

            uniform float u_rain;
            uniform float u_heavy_rain;
            uniform float u_drizzle;
            uniform float u_snow;
            uniform float u_blizzard;
            uniform float u_dust;
            uniform float u_fog;
            uniform float u_thunder;
            uniform float u_lightning;
            uniform float u_bolt_seed;
            uniform float u_vignette;
            uniform float u_aurora;
            uniform sampler2D u_noise_tex;

            float noise3D(in vec3 x) {
                vec3 p = floor(x);
                vec3 f = fract(x);
                f = f * f * (3.0 - 2.0 * f);
                vec2 uv = p.xy + vec2(37.0, 17.0) * p.z + f.xy;
                vec2 uv0 = (uv + 0.5) / 256.0;
                vec2 uv1 = (uv + vec2(37.0, 17.0) + 0.5) / 256.0;
                float z0 = texture2D(u_noise_tex, uv0).r;
                float z1 = texture2D(u_noise_tex, uv1).r;
                return mix(z0, z1, f.z);
            }

            float fbm3D(vec3 p) {
                float f = 0.0;
                f += 0.5000 * noise3D(p); p = p * 2.02 + vec3(0.15, 0.32, 0.47);
                f += 0.2500 * noise3D(p); p = p * 2.03 + vec3(0.35, 0.12, 0.28);
                f += 0.1250 * noise3D(p); p = p * 2.01 + vec3(0.12, 0.45, 0.19);
                f += 0.0250 * noise3D(p); // Reduced finest octave to avoid visible grain
                return f / 0.9;
            }

            float hash(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
            }

            vec2 hash2(vec2 p) {
                p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
                return fract(sin(p) * 43758.5453123);
            }

            // IDEA1_ATMOSPHERE_V2 — lightweight procedural stars and aurora curtains.
            float getStarField(vec2 uv, float aspect) {
                vec2 grid = uv * vec2(112.0 * aspect, 64.0);
                vec2 cell = floor(grid);
                vec2 localPos = fract(grid);
                vec2 rnd = hash2(cell + vec2(13.1, 51.7));
                float exists = step(0.977, rnd.x);
                vec2 center = 0.14 + rnd.yx * 0.72;
                float dist = length((localPos - center) * vec2(1.0, 1.15));
                float core = 1.0 - smoothstep(0.0, 0.055 + 0.025 * rnd.y, dist);
                float twinkle = 0.78 + 0.22 * sin(u_time * (0.55 + rnd.y * 1.7) + rnd.x * 31.0);
                float skyMask = smoothstep(0.12, 0.34, uv.y);
                return core * exists * twinkle * skyMask;
            }

            float getAurora(vec2 uv, float aspect) {
                float x = uv.x * aspect;
                float t = u_time * 0.035;
                float waveA = sin(x * 2.8 + sin(x * 1.2 + t) * 0.7 + t) * 0.075;
                float waveB = sin(x * 5.6 - t * 0.7) * 0.032;
                float center = 0.62 + waveA + waveB;
                float band = 1.0 - smoothstep(0.008, 0.19, abs(uv.y - center));
                float ribbons = 0.45 + 0.55 * sin(x * 13.0 + sin(x * 3.0 + t) * 1.4 - t * 1.8);
                float verticalMask = smoothstep(0.36, 0.53, uv.y) * (1.0 - smoothstep(0.79, 0.92, uv.y));
                float detail = 0.55 + 0.45 * noise3D(vec3(x * 1.6, uv.y * 4.2, u_time * 0.012));
                return band * max(0.0, ribbons) * verticalMask * detail;
            }

            vec3 getSkyBackground(vec3 rd, float sunAlt, float cloudCov, float u_cloud_type) {
                float dayFactor = smoothstep(-0.12, 0.24, sunAlt);
                float twilightFactor = exp(-pow((sunAlt + 0.075) / 0.19, 2.0));
                float goldenHour = exp(-pow((sunAlt - 0.105) / 0.15, 2.0));
                float h = max(0.0, rd.y);

                // IDEA1_ATMOSPHERE_V2 — richer golden hour, blue hour and deep-night palette.
                vec3 clearZenith = vec3(0.10, 0.34, 0.78);
                vec3 clearHorizon = vec3(0.62, 0.80, 0.96);
                vec3 goldenZenith = vec3(0.23, 0.18, 0.39);
                vec3 goldenHorizon = vec3(1.00, 0.40, 0.20);
                vec3 twilightZenith = vec3(0.12, 0.10, 0.29);
                vec3 twilightHorizon = vec3(0.48, 0.29, 0.48);
                vec3 nightZenith = vec3(0.008, 0.012, 0.035);
                vec3 nightHorizon = vec3(0.028, 0.050, 0.12);

                vec3 skyNight = mix(nightHorizon, nightZenith, pow(h, 0.75));
                vec3 skyDay = mix(clearHorizon, clearZenith, pow(h, 0.65));
                vec3 skyClear = mix(skyNight, skyDay, dayFactor);
                skyClear = mix(skyClear, mix(twilightHorizon, twilightZenith, pow(h, 0.58)), twilightFactor * 0.72);
                skyClear = mix(skyClear, mix(goldenHorizon, goldenZenith, pow(h, 0.58)), goldenHour * 0.78);

                // Пасмурное / грозовое небо
                vec3 overcastZenith = mix(vec3(0.22, 0.26, 0.32), vec3(0.12, 0.14, 0.19), u_thunder);
                vec3 overcastHorizon = mix(vec3(0.46, 0.50, 0.56), vec3(0.24, 0.27, 0.33), u_thunder);
                vec3 overcastNight = vec3(0.025, 0.030, 0.045);
                vec3 skyOvercast = mix(overcastNight, mix(overcastHorizon, overcastZenith, h), dayFactor);
                skyOvercast = mix(skyOvercast, vec3(0.32, 0.22, 0.38), twilightFactor * 0.25 * (1.0 - u_thunder));
                skyOvercast = mix(skyOvercast, vec3(0.68, 0.32, 0.24), goldenHour * 0.18 * (1.0 - u_thunder));

                // Зимняя стальная атмосфера
                vec3 winterZenith = vec3(0.20, 0.26, 0.36);
                vec3 winterHorizon = vec3(0.46, 0.52, 0.60);
                vec3 skyWinter = mix(overcastNight, mix(winterHorizon, winterZenith, h), dayFactor);
                skyOvercast = mix(skyOvercast, skyWinter, max(u_snow, u_blizzard));

                // Песчаная мгла
                vec3 dustZenith = vec3(0.42, 0.30, 0.16);
                vec3 dustHorizon = vec3(0.70, 0.52, 0.32);
                vec3 skyDust = mix(vec3(0.07, 0.05, 0.03), mix(dustHorizon, dustZenith, h), dayFactor);

                float overcastWeight = smoothstep(0.25, 0.85, cloudCov) * max(u_cloud_type, max(u_snow, u_blizzard));
                vec3 result = mix(skyClear, skyOvercast, overcastWeight);
                return mix(result, skyDust, u_dust);
            }

            // Мягкая плотность облака с шелковистыми краями
            // IDEA2_VOLUMETRIC_CLOUDS — stacked cloud profiles sharing the live weather controls.
            float getCloudDensity(vec3 p, vec3 windShift, float cloudCov, out float hFraction) {
                hFraction = (p.y - 1.2) / 1.8;
                if (hFraction < 0.0 || hFraction > 1.0) return 0.0;

                vec3 rawCoord = (p + windShift) * 0.32;
                float highLayerBlend = smoothstep(0.34, 0.72, hFraction);
                // Stretch the noise horizontally aloft to form thin, elongated wisps without extra samples.
                vec3 sampleCoord = rawCoord;
                sampleCoord.x *= mix(1.0, 0.28, highLayerBlend);
                sampleCoord.z *= mix(1.0, 0.52, highLayerBlend);
                float baseNoise = fbm3D(sampleCoord);
                float billow = 1.0 - abs(baseNoise * 2.0 - 1.0);

                // Main cloud bodies occupy the lower and middle part of the volume.
                // The upper profile shares the same samples, so wisps add no extra texture lookups.
                float bodyProfile = smoothstep(0.0, 0.20, hFraction) *
                                    (1.0 - smoothstep(0.62, 0.94, hFraction));
                float bodyShape = mix(baseNoise, billow, 0.62) * bodyProfile;
                float threshold = mix(0.78, 0.10, cloudCov);
                float bodyDensity = smoothstep(threshold, threshold + 0.22, bodyShape);

                // Thin cirrus-like strands appear only with partial cloud cover and fade into overcast.
                float cirrusProfile = smoothstep(0.38, 0.56, hFraction) *
                                      (1.0 - smoothstep(0.78, 0.98, hFraction));
                float ridgeField = 1.0 - abs(baseNoise * 2.0 - 1.0);
                float cirrusThreshold = mix(0.88, 0.62, cloudCov);
                float cirrusStrands = smoothstep(cirrusThreshold, cirrusThreshold + 0.12, ridgeField);
                float cirrusAmount = (1.0 - u_cloud_type) * smoothstep(0.16, 0.55, cloudCov) *
                                     (0.18 + 0.22 * cloudCov);
                float cirrusDensity = cirrusStrands * cirrusProfile * cirrusAmount;

                return clamp(max(bodyDensity, cirrusDensity), 0.0, 1.0);
            }

            float getRain(vec2 uv, float aspect, float heavy) {
                vec2 p = uv;
                p.x -= p.y * (u_wind.x * (0.35 + heavy * 0.25));

                float rFar = 0.0;
                float rMid = 0.0;
                float rNear = 0.0;

                float colFar = floor(p.x * (160.0 + heavy * 80.0) * aspect);
                vec2 rndFar = hash2(vec2(colFar, 13.7));
                if (rndFar.x > (0.65 - heavy * 0.15)) {
                    float speed = 1.8 + heavy * 0.9 + rndFar.y * 0.4;
                    float dy = fract(rndFar.x * 11.0 - u_time * speed) - uv.y;
                    if (dy < 0.0) dy += 1.0;
                    float streakLen = 0.045 + heavy * 0.025;
                    if (dy < streakLen) {
                        float needle = smoothstep(0.12, 0.0, abs(fract(p.x * (160.0 + heavy * 80.0) * aspect) - 0.5));
                        rFar = needle * smoothstep(0.0, 0.008, dy) * smoothstep(streakLen, streakLen * 0.35, dy);
                    }
                }

                float colMid = floor(p.x * (105.0 + heavy * 50.0) * aspect);
                vec2 rndMid = hash2(vec2(colMid, 29.3));
                if (rndMid.x > (0.68 - heavy * 0.15)) {
                    float speed = 2.4 + heavy * 1.1 + rndMid.y * 0.5;
                    float dy = fract(rndMid.x * 17.0 - u_time * speed) - uv.y;
                    if (dy < 0.0) dy += 1.0;
                    float streakLen = 0.065 + heavy * 0.035;
                    if (dy < streakLen) {
                        float needle = smoothstep(0.14, 0.0, abs(fract(p.x * (105.0 + heavy * 50.0) * aspect) - 0.5));
                        rMid = needle * smoothstep(0.0, 0.012, dy) * smoothstep(streakLen, streakLen * 0.35, dy);
                    }
                }

                float colNear = floor(p.x * (60.0 + heavy * 35.0) * aspect);
                vec2 rndNear = hash2(vec2(colNear, 47.1));
                if (rndNear.x > (0.72 - heavy * 0.15)) {
                    float speed = 3.1 + heavy * 1.3 + rndNear.y * 0.6;
                    float dy = fract(rndNear.x * 23.0 - u_time * speed) - uv.y;
                    if (dy < 0.0) dy += 1.0;
                    float streakLen = 0.085 + heavy * 0.045;
                    if (dy < streakLen) {
                        float needle = smoothstep(0.16, 0.0, abs(fract(p.x * (60.0 + heavy * 35.0) * aspect) - 0.5));
                        rNear = needle * smoothstep(0.0, 0.016, dy) * smoothstep(streakLen, streakLen * 0.35, dy);
                    }
                }

                float spray = smoothstep(0.28, 0.0, uv.y) * heavy * 0.35;
                return (rFar * 0.35 + rMid * 0.60 + rNear * 0.90) + spray;
            }

            float getDrizzle(vec2 uv, float aspect) {
                vec2 p = uv;
                p.x -= p.y * (u_wind.x * 0.25);
                p.y += u_time * 0.75;

                vec2 st = p * vec2(280.0 * aspect, 180.0);
                vec2 id = floor(st);
                vec2 f = fract(st);

                vec2 rnd = hash2(id + vec2(17.3, 41.9));
                if (rnd.x < 0.72) return 0.0;

                float dist = length(f - vec2(0.5));
                float dotVal = smoothstep(0.22, 0.0, dist);
                return dotVal * dotVal * (0.35 + 0.65 * rnd.y);
            }

            float getSnow(vec2 uv, float aspect, float blizzard) {
                float totalSnow = 0.0;
                for (int l = 0; l < 3; l++) {
                    float scale = (l == 0) ? (32.0 + blizzard * 20.0) : ((l == 1) ? (18.0 + blizzard * 12.0) : (9.0 + blizzard * 6.0));
                    float speed = (l == 0) ? (0.09 + blizzard * 0.28) : ((l == 1) ? (0.15 + blizzard * 0.38) : (0.22 + blizzard * 0.52));
                    float baseRad = (l == 0) ? 0.07 : ((l == 1) ? 0.10 : 0.15);
                    float seed = float(l) * 31.7;

                    vec2 p = uv;
                    p.x -= (u_wind.x * (0.20 + blizzard * 0.85) + blizzard * 0.45) * u_time + seed;
                    p.y += u_time * speed;

                    vec2 st = p * scale * vec2(aspect, 1.0);
                    vec2 id = floor(st);
                    vec2 f = fract(st);

                    vec2 r1 = hash2(id + vec2(seed, 0.0));
                    vec2 r2 = hash2(id + vec2(seed * 2.1, 19.3));

                    if (r1.x > (0.65 - blizzard * 0.18)) {
                        float swayX = sin(u_time * (0.6 + r2.x * 0.5) + r1.y * 6.28) * (0.10 - blizzard * 0.07);
                        float swayY = cos(u_time * (0.5 + r1.x * 0.4) + r2.y * 6.28) * 0.03;
                        vec2 center = vec2(0.3 + 0.4 * r1.y + swayX, 0.3 + 0.4 * r2.y + swayY);
                        float d = length(f - center);
                        float flake = smoothstep(baseRad * (0.7 + 0.5 * r2.x), 0.0, d);
                        totalSnow += flake * flake * (l == 0 ? 0.35 : (l == 1 ? 0.65 : 0.95));
                    }
                }
                return totalSnow;
            }

            float getDust(vec2 uv, float aspect) {
                vec2 p = uv;
                p.x -= (u_wind.x * 0.60 + 0.40) * u_time;
                p.y += sin(u_time * 0.8 + uv.x * 5.0) * 0.03;

                vec2 st = p * vec2(140.0 * aspect, 120.0);
                vec2 id = floor(st);
                vec2 f = fract(st);

                vec2 r = hash2(id + vec2(53.1, 88.7));
                if (r.x < 0.78) return 0.0;

                float dist = length(f - vec2(0.5));
                float grain = smoothstep(0.24, 0.0, dist);
                return grain * grain * (0.4 + 0.6 * r.y);
            }

            float getLightning(vec2 uv, float seed) {
                float trunkX = 0.5 + (sin(uv.y * 9.0 + seed * 10.0) * 0.08 +
                                      sin(uv.y * 28.0 + seed * 20.0) * 0.04 +
                                      (noise3D(vec3(uv.y * 8.0, seed * 5.0, 1.0)) - 0.5) * 0.18);
                float dist = abs(uv.x - trunkX);
                float core = 0.0018 / (dist + 0.0018);
                float glow = 0.035 / (dist * dist * 350.0 + 0.035);
                return (core + glow) * smoothstep(1.0, 0.1, uv.y);
            }

            void main() {
                vec2 uv = vUv;
                float aspect = u_resolution.x / u_resolution.y;

                vec2 screenP = (uv - 0.5) * vec2(aspect, 1.0);
                vec3 rd = normalize(vec3(screenP.x, screenP.y + 0.65, 1.15));
                vec3 ro = vec3(0.0, 0.0, 0.0);

                float dayFactor = smoothstep(-0.1, 0.25, u_sun_alt);

                // 1. Небесный купол
                vec3 col = getSkyBackground(rd, u_sun_alt, u_cloud_cov, u_cloud_type);

                // IDEA1_ATMOSPHERE_V2 — stars and aurora fade with real solar altitude.
                float nightFactor = 1.0 - smoothstep(-0.18, 0.055, u_sun_alt);
                if (nightFactor > 0.001) {
                    float starVisibility = nightFactor * (1.0 - u_fog * 0.70) * (1.0 - u_dust * 0.45);
                    float stars = getStarField(uv, aspect);
                    col += vec3(0.66, 0.78, 1.0) * stars * starVisibility * 0.82;

                    if (u_aurora > 0.001) {
                        float auroraVisibility = u_aurora * nightFactor * (1.0 - u_cloud_cov * 0.78) * (1.0 - u_fog * 0.82) * (1.0 - u_dust * 0.75);
                        float auroraShape = getAurora(uv, aspect) * auroraVisibility;
                        col += vec3(0.08, 0.95, 0.55) * auroraShape * 0.42;
                        col += vec3(0.19, 0.34, 1.0) * pow(auroraShape, 2.0) * 0.48;
                    }
                }

                // --- 2. СОЛНЦЕ И ЛУНА ---
                if (u_sun_alt > -0.15 && u_dust < 0.7) {
                    vec2 sunP = (u_sun_uv - 0.5) * vec2(aspect, 1.0);
                    float sunDist = length(screenP - sunP);
                    float sunTranslucency = mix(1.0, 0.20, smoothstep(0.1, 0.95, u_cloud_cov));
                    float sunCore = smoothstep(0.038, 0.024, sunDist) * sunTranslucency;
                    float sunHalo = (0.04 / (sunDist * 1.8 + 0.05)) * sunTranslucency;
                    vec3 sunCol = mix(vec3(1.0, 0.5, 0.2), vec3(1.0, 0.98, 0.92), smoothstep(0.0, 0.3, u_sun_alt));
                    col += (sunCore + sunHalo * 0.5) * sunCol;
                }

                if (u_moon_alt > -0.15) {
                    vec2 moonP = (u_moon_uv - 0.5) * vec2(aspect, 1.0);
                    float moonDist = length(screenP - moonP);
                    float moonTranslucency = mix(1.0, 0.25, smoothstep(0.1, 0.95, u_cloud_cov));
                    vec2 moonLocal = vec2((screenP.x - moonP.x) / (0.035 * aspect), (screenP.y - moonP.y) / 0.035);
                    float moonRadius = length(moonLocal);
                    float moonDisk = 1.0 - smoothstep(0.92, 1.0, moonRadius);
                    float phaseAngle = u_moon_phase * 6.2831853;
                    float phaseCos = cos(phaseAngle);
                    float phaseSin = sin(phaseAngle);
                    float terminator = phaseCos * sqrt(max(0.0, 1.0 - moonLocal.y * moonLocal.y));
                    float waxingSide = phaseSin < 0.0 ? -1.0 : 1.0;
                    float moonLit = step(0.0, moonLocal.x * waxingSide - terminator);
                    float moonIllumination = 0.5 - 0.5 * cos(phaseAngle);
                    float moonCore = moonDisk * moonLit * moonTranslucency;
                    float moonHalo = (0.03 / (moonDist * 2.0 + 0.05)) * moonTranslucency * mix(0.12, 1.0, moonIllumination);
                    vec3 moonCol = vec3(0.88, 0.93, 1.0);
                    col += (moonCore * 1.5 + moonHalo * 0.4) * moonCol * smoothstep(-0.15, 0.1, u_moon_alt);
                }

                if (u_dust > 0.1 && u_sun_alt > 0.0) {
                    vec2 sunP = (u_sun_uv - 0.5) * vec2(aspect, 1.0);
                    float sunDist = length(screenP - sunP);
                    float dustSun = smoothstep(0.06, 0.02, sunDist) * 0.45 * u_dust;
                    col += vec3(0.95, 0.45, 0.18) * dustSun;
                }

                // IDEA2_VOLUMETRIC_CLOUDS — subtle screen-space shafts, naturally occluded by the cloud volume.
                if (u_sun_alt > -0.12 && u_cloud_cov > 0.12 && u_dust < 0.65) {
                    vec2 raySunP = (u_sun_uv - 0.5) * vec2(aspect, 1.0);
                    vec2 rayDelta = screenP - raySunP;
                    float rayDistance = length(rayDelta);
                    float rayAngle = atan(rayDelta.y, rayDelta.x);
                    float rayWave = sin(rayAngle * 9.0 + sin(rayAngle * 2.7 + u_time * 0.018) * 0.75);
                    float rayPattern = pow(max(0.0, 0.5 + 0.5 * rayWave), 16.0);
                    float brokenCloudWeight = smoothstep(0.12, 0.36, u_cloud_cov) *
                                              (1.0 - smoothstep(0.58, 0.92, u_cloud_cov));
                    float raySunlight = smoothstep(-0.12, 0.08, u_sun_alt) *
                                        (1.0 - u_thunder * 0.90) * (1.0 - u_fog * 0.65);
                    float rays = rayPattern * exp(-rayDistance * 0.80) * brokenCloudWeight * raySunlight *
                                (1.0 - u_cloud_type * 0.75) *
                                (1.0 - max(u_snow, u_blizzard) * 0.55);
                    vec3 rayTint = mix(vec3(1.0, 0.43, 0.22), vec3(1.0, 0.93, 0.81),
                                       smoothstep(-0.02, 0.20, u_sun_alt));
                    col += rayTint * rays * 0.16;
                }

                // --- 3. 3D RAYMARCHING ОБЛАКОВ С РЕАЛИСТИЧНЫМ РАССЕЯНИЕМ ---
                if (u_cloud_cov > 0.02 && rd.y > 0.04) {
                    float tStart = 1.2 / rd.y;
                    float tEnd = 3.0 / rd.y;
                    tEnd = min(tEnd, tStart + 7.5);

                    float marchDist = tEnd - tStart;
                    const int STEPS = 28;
                    float stepSize = marchDist / float(STEPS);

                    // Stable per-pixel jitter avoids temporal grain/shimmer between frames.
                    // Narrow, stable jitter minimizes visible grain while reducing raymarch banding.
                    float jitter = 0.5 + (hash(gl_FragCoord.xy) - 0.5) * 0.10;
                    float t = tStart + stepSize * jitter;

                    vec3 windShift = vec3(u_wind.x, 0.0, u_wind.y) * (u_time * 0.35);

                    // Улучшенные палитры: глубокие синевато-воздушные тени вместо серой грязи
                    vec3 overcastShadow = mix(vec3(0.20, 0.23, 0.28), vec3(0.10, 0.12, 0.16), u_thunder);
                    vec3 overcastHighlight = mix(vec3(0.62, 0.66, 0.72), vec3(0.40, 0.44, 0.50), u_thunder);

                    vec3 cumulusLight = vec3(0.98, 0.99, 1.0);
                    vec3 cumulusDark  = vec3(0.56, 0.64, 0.76); // Воздушный небесный оттенок в тенях

                    vec3 cloudBaseDark = mix(cumulusDark, overcastShadow, u_cloud_type);
                    vec3 cloudBaseLight = mix(cumulusLight, overcastHighlight, u_cloud_type);

                    vec3 winterShadow = vec3(0.26, 0.30, 0.38);
                    vec3 winterHighlight = vec3(0.60, 0.65, 0.72);
                    float winterWeight = max(u_snow, u_blizzard);
                    cloudBaseDark = mix(cloudBaseDark, winterShadow, winterWeight);
                    cloudBaseLight = mix(cloudBaseLight, winterHighlight, winterWeight);

                    cloudBaseDark = mix(cloudBaseDark, vec3(0.35, 0.26, 0.18), u_dust);
                    cloudBaseLight = mix(cloudBaseLight, vec3(0.68, 0.52, 0.36), u_dust);

                    float twilightWarmth = exp(-pow((u_sun_alt - 0.035) / 0.12, 2.0));
                    float directSun = smoothstep(-0.08, 0.18, u_sun_alt) * (1.0 - u_thunder * 0.88);
                    vec3 twilightLight = mix(vec3(1.0, 0.40, 0.22), vec3(1.0, 0.93, 0.82),
                                             smoothstep(-0.02, 0.20, u_sun_alt));
                    cloudBaseLight = mix(cloudBaseLight, twilightLight,
                                         twilightWarmth * (1.0 - u_cloud_type * 0.58) *
                                         (1.0 - winterWeight * 0.35) * 0.72);
                    cloudBaseDark = mix(cloudBaseDark, vec3(0.18, 0.15, 0.25),
                                        twilightWarmth * 0.20 * (1.0 - u_thunder));

                    // Approximate the light direction in the same ray-marched volume.
                    vec3 sunDir = normalize(vec3((u_sun_uv.x - 0.5) * 1.5, max(0.06, u_sun_alt), 0.5));
                    float forwardScatter = pow(max(0.0, dot(rd, sunDir)), 5.5) *
                                           (1.0 - u_cloud_type * 0.35) * (1.0 - winterWeight);
                    cloudBaseLight = mix(cloudBaseLight, vec3(1.0, 0.97, 0.90),
                                         forwardScatter * 0.45 * directSun * (1.0 - u_cloud_type * 0.78) * (1.0 - max(u_thunder, u_heavy_rain * 0.65) * 0.85) * (1.0 - max(u_snow, u_blizzard) * 0.58));

                    // WEATHER_CLOUDS_GRAIN_AND_CONTRAST_V1 — restore live-weather cloud colours.
                    // Cloud type/coverage/precipitation drive colour continuously; this is not a scene switch.
                    float denseOvercastV2 = smoothstep(0.52, 0.92, u_cloud_cov);
                    float stormDarknessV2 = clamp(max(u_thunder, max(u_heavy_rain * 0.78, u_rain * 0.28)), 0.0, 1.0);
                    float snowCloudWeightV2 = clamp(max(u_snow, u_blizzard), 0.0, 1.0);
                    float weatherCloudGreyWeightV2 = clamp(max(u_cloud_type,
                        max(denseOvercastV2 * 0.72, max(u_thunder, max(u_heavy_rain, u_rain * 0.55)))), 0.0, 1.0);

                    // Diffuse grey daylight for overcast clouds; storm clouds move toward charcoal blue-grey.
                    vec3 weatherCloudLightV2 = mix(vec3(0.54, 0.56, 0.59), vec3(0.29, 0.31, 0.35), stormDarknessV2);
                    vec3 weatherCloudDarkV2  = mix(vec3(0.22, 0.24, 0.28), vec3(0.075, 0.085, 0.11), stormDarknessV2);
                    // Snow clouds are cold grey, not pure white; highlights remain slightly bluish.
                    vec3 snowCloudLightV2 = vec3(0.48, 0.52, 0.59);
                    vec3 snowCloudDarkV2  = vec3(0.15, 0.18, 0.23);

                    float nonSnowGreyV2 = weatherCloudGreyWeightV2 * (1.0 - snowCloudWeightV2 * 0.62);
                    cloudBaseLight = mix(cloudBaseLight, weatherCloudLightV2, nonSnowGreyV2);
                    cloudBaseDark  = mix(cloudBaseDark, weatherCloudDarkV2, nonSnowGreyV2);
                    cloudBaseLight = mix(cloudBaseLight, snowCloudLightV2, snowCloudWeightV2 * 0.85);
                    cloudBaseDark  = mix(cloudBaseDark, snowCloudDarkV2, snowCloudWeightV2 * 0.85);

                    vec3 cloudDark = mix(vec3(0.025, 0.03, 0.05), cloudBaseDark, dayFactor);
                    vec3 cloudLight = mix(vec3(0.05, 0.07, 0.11), cloudBaseLight, dayFactor);

                    vec4 cloudAccum = vec4(0.0);

                    for (int i = 0; i < STEPS; i++) {
                        vec3 pos = ro + rd * t;
                        float hFraction;
                        float density = getCloudDensity(pos, windShift, u_cloud_cov, hFraction);

                        if (density > 0.005) {
                            float dummyH;
                            // Sample toward the sun rather than only vertically for directional self-shadowing.
                            vec3 lightSampleOffset = sunDir * 0.27 + vec3(0.0, 0.06, 0.0);
                            float lightDensity = getCloudDensity(pos + lightSampleOffset, windShift, u_cloud_cov, dummyH);
                            float shadow = clamp((density - lightDensity) * 3.4 + 0.30, 0.12, 1.0);

                            vec3 stepColor = mix(cloudDark, cloudLight, shadow);

                            // Fine edge band catches warm low-angle light and neutral daylight.
                            float edgeBand = smoothstep(0.015, 0.095, density) *
                                             (1.0 - smoothstep(0.16, 0.44, density));
                            float cloudSunVisibility = smoothstep(-0.08, 0.18, u_sun_alt) *
                                                       (1.0 - u_thunder * 0.92) * (1.0 - u_dust * 0.40) *
                                                       (1.0 - u_cloud_type * 0.72) * (1.0 - u_heavy_rain * 0.45) *
                                                       (1.0 - max(u_snow, u_blizzard) * 0.50);
                            float sunFacing = 0.20 + 0.80 * pow(max(0.0, dot(rd, sunDir)), 2.0);
                            vec3 rimColor = mix(vec3(1.0, 0.48, 0.27), vec3(1.0, 0.96, 0.87),
                                                smoothstep(-0.01, 0.20, u_sun_alt));
                            stepColor += rimColor * edgeBand * sunFacing * cloudSunVisibility * 0.42;

                            // Volumetric light transmission through thinner cloud regions.
                            if (u_sun_alt > -0.08) {
                                float sunAngle = max(0.0, dot(rd, sunDir));
                                float translucency = exp(-density * 2.2);
                                stepColor += rimColor * pow(sunAngle, 5.5) * translucency * cloudSunVisibility * 0.38;
                            }

                            if (u_lightning > 0.01) {
                                stepColor += vec3(0.85, 0.92, 1.0) * u_lightning * 1.8 * (1.0 - shadow * 0.5);
                            }

                            float stepAlpha = density * u_cloud_density * 0.45;
                            cloudAccum.rgb += (1.0 - cloudAccum.a) * stepColor * stepAlpha;
                            cloudAccum.a += (1.0 - cloudAccum.a) * stepAlpha;

                            if (cloudAccum.a > 0.98) break;
                        }
                        t += stepSize;
                    }

                    float horizonHaze = smoothstep(0.04, 0.35, rd.y);
                    // cloudAccum.rgb is already front-to-back alpha-premultiplied.
                    col = col * (1.0 - cloudAccum.a * horizonHaze) + cloudAccum.rgb * horizonHaze;
                }

                // 4. Осадки
                if (u_lightning > 0.05) {
                    float bolt = getLightning(uv, u_bolt_seed) * u_lightning;
                    col += vec3(0.85, 0.92, 1.0) * bolt;
                    col += vec3(0.25, 0.32, 0.45) * u_lightning * 0.40;
                }

                float rainIntensity = max(u_rain, u_heavy_rain);
                if (rainIntensity > 0.01) {
                    float rainVal = getRain(uv, aspect, u_heavy_rain) * rainIntensity;
                    col = mix(col, vec3(0.75, 0.82, 0.90), clamp(rainVal, 0.0, 0.78));
                }

                if (u_drizzle > 0.01) {
                    float drizVal = getDrizzle(uv, aspect) * u_drizzle;
                    col = mix(col, vec3(0.80, 0.85, 0.92), clamp(drizVal, 0.0, 0.65));
                }

                float snowIntensity = max(u_snow, u_blizzard);
                if (snowIntensity > 0.01) {
                    float snowVal = getSnow(uv, aspect, u_blizzard) * snowIntensity;
                    col = mix(col, vec3(0.95, 0.97, 1.0), clamp(snowVal, 0.0, 0.85));

                    if (u_blizzard > 0.05) {
                        float whiteout = smoothstep(0.0, 0.75, 1.0 - uv.y) * u_blizzard * 0.35;
                        col = mix(col, vec3(0.88, 0.92, 0.96), whiteout);
                    }
                }

                if (u_dust > 0.01) {
                    float dustParticles = getDust(uv, aspect) * u_dust;
                    col = mix(col, vec3(0.82, 0.64, 0.42), clamp(dustParticles, 0.0, 0.65));
                }

                if (u_fog > 0.01) {
                    float fogGrad = smoothstep(0.75, 0.05, uv.y) * u_fog;
                    vec3 fogColor = mix(vec3(0.08, 0.1, 0.14), vec3(0.68, 0.72, 0.78), dayFactor);
                    col = mix(col, fogColor, fogGrad * 0.82);
                }

                // 5. Виньетка
                if (u_vignette > 0.5) {
                    vec2 vCenter = (uv - 0.5) * vec2(aspect, 1.0);
                    float vig = smoothstep(0.85, 0.25, length(vCenter));
                    col *= mix(0.75, 1.0, vig);
                }

                gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
            }
        `;

        this.uniforms = {
            u_resolution:    { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
            u_time:          { value: 0.0 },
            u_sun_uv:        { value: new THREE.Vector2(0.5, 0.5) },
            u_sun_alt:       { value: 0.5 },
            u_moon_uv:       { value: new THREE.Vector2(0.5, 0.5) },
            u_moon_alt:      { value: -0.5 },
            u_moon_phase:    { value: 0.5 },
            u_aurora:        { value: 0.0 },
            u_wind:          { value: new THREE.Vector2(0.03, 0.0) },
            u_cloud_cov:     { value: 1.0 },
            u_cloud_density: { value: 0.95 },
            u_cloud_type:    { value: 1.0 },
            u_rain:          { value: 0.0 },
            u_heavy_rain:    { value: 0.0 },
            u_drizzle:       { value: 0.0 },
            u_snow:          { value: 0.0 },
            u_blizzard:      { value: 0.0 },
            u_dust:          { value: 0.0 },
            u_fog:           { value: 0.0 },
            u_thunder:       { value: 0.0 },
            u_lightning:     { value: 0.0 },
            u_bolt_seed:     { value: 0.5 },
            u_vignette:      { value: 1.0 },
            u_noise_tex:     { value: this.noiseTexture }
        };

        this.material = new THREE.ShaderMaterial({
            vertexShader: vertexShader,
            fragmentShader: fragmentShader,
            uniforms: this.uniforms,
            depthWrite: false,
            depthTest: false
        });
    }

    resize(qualityScale = 1.0) {
        this.qualityScale = qualityScale;
        const w = Math.floor(window.innerWidth * this.qualityScale);
        const h = Math.floor(window.innerHeight * this.qualityScale);

        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.renderer.setSize(w, h, false);
            this.uniforms.u_resolution.value.set(w, h);
        }
    }

    render(timeSec, state, celestial, lightningVal) {
        this.uniforms.u_time.value = timeSec;

        this.uniforms.u_sun_uv.value.set(celestial.sunUV[0], celestial.sunUV[1]);
        this.uniforms.u_sun_alt.value = celestial.sunAlt;
        this.uniforms.u_moon_uv.value.set(celestial.moonUV[0], celestial.moonUV[1]);
        this.uniforms.u_moon_alt.value = celestial.moonAlt;
        this.uniforms.u_moon_phase.value = celestial.moonPhase ?? 0.5;
        this.uniforms.u_aurora.value = state.aurora ?? 0.0;

        this.uniforms.u_wind.value.set(state.windVec[0], state.windVec[1]);

        this.uniforms.u_cloud_cov.value = state.cloudCoverage;
        this.uniforms.u_cloud_density.value = state.cloudDensity;
        this.uniforms.u_cloud_type.value = state.u_cloud_type;

        this.uniforms.u_rain.value = state.rain;
        this.uniforms.u_heavy_rain.value = state.heavyRain;
        this.uniforms.u_drizzle.value = state.drizzle;
        this.uniforms.u_snow.value = state.snow;
        this.uniforms.u_blizzard.value = state.blizzard;
        this.uniforms.u_dust.value = state.dust;
        this.uniforms.u_fog.value = state.fog;
        this.uniforms.u_thunder.value = state.thunder;

        if (lightningVal > 0.8 && Math.random() < 0.2) {
            this.lightningSeed = Math.random();
        }
        this.uniforms.u_lightning.value = lightningVal;
        this.uniforms.u_bolt_seed.value = this.lightningSeed;
        this.uniforms.u_vignette.value = state.showVignette ? 1.0 : 0.0;

        this.renderer.render(this.scene, this.camera);
    }
}

window.WeatherShaderEngine = WeatherShaderEngine;