/*
 * EnvironmentSystem - procedural environment generators for WeatheriOS.
 * Kept separate from weather.js: this module owns environment GLSL and controls.
 * It intentionally reuses the weather shader's existing weather/time uniforms.
 */
'use strict';

window.EnvironmentSystem = (function () {
    const target = {
        enabled: 0.0,
        type: 1.0,       // 1 mountains, 2 forest, 3 city, 4 ocean
        height: 0.35,
        density: 0.65,
        detail: 0.65,
        depth: 0.70,
        motion: 0.35,
        cityLights: 1.0
    };

    const current = Object.assign({}, target);
    let lastShaderTime = null;

    function clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }

    function numberValue(property, fallback) {
        if (!property || property.value === undefined || property.value === null) return fallback;
        const result = Number(property.value);
        return Number.isFinite(result) ? result : fallback;
    }

    function sliderValue(property, fallback) {
        return clamp01(numberValue(property, fallback * 100) / 100);
    }

    function applyProperties(props) {
        if (!props) return;

        if (props.environment_enabled) target.enabled = props.environment_enabled.value ? 1.0 : 0.0;
        if (props.environment_type) {
            const type = Math.round(numberValue(props.environment_type, 1));
            target.type = Math.max(1, Math.min(4, type));
        }
        if (props.environment_height) target.height = sliderValue(props.environment_height, target.height);
        if (props.environment_density) target.density = sliderValue(props.environment_density, target.density);
        if (props.environment_detail) target.detail = sliderValue(props.environment_detail, target.detail);
        if (props.environment_depth) target.depth = sliderValue(props.environment_depth, target.depth);
        if (props.environment_motion) target.motion = sliderValue(props.environment_motion, target.motion);
        if (props.environment_city_lights) target.cityLights = props.environment_city_lights.value ? 1.0 : 0.0;

        // A type selection is discrete. Geometry/visibility controls ease smoothly.
        current.type = target.type;
    }

    function getUniforms() {
        return {
            u_env_enabled:   { value: current.enabled },
            u_env_type:      { value: current.type },
            u_env_height:    { value: current.height },
            u_env_density:   { value: current.density },
            u_env_detail:    { value: current.detail },
            u_env_depth:     { value: current.depth },
            u_env_motion:    { value: current.motion },
            u_env_city_lights: { value: current.cityLights }
        };
    }

    function updateUniforms(uniforms, timeSec) {
        if (!uniforms) return;
        let dt = 1.0 / 60.0;
        if (lastShaderTime !== null && Number.isFinite(timeSec)) {
            dt = Math.max(0.0, Math.min(0.1, timeSec - lastShaderTime));
        }
        if (Number.isFinite(timeSec)) lastShaderTime = timeSec;
        const blend = 1.0 - Math.exp(-dt * 3.8);
        const smoothKeys = ['enabled', 'height', 'density', 'detail', 'depth', 'motion', 'cityLights'];
        for (const key of smoothKeys) current[key] += (target[key] - current[key]) * blend;

        uniforms.u_env_enabled.value = current.enabled;
        uniforms.u_env_type.value = current.type;
        uniforms.u_env_height.value = current.height;
        uniforms.u_env_density.value = current.density;
        uniforms.u_env_detail.value = current.detail;
        uniforms.u_env_depth.value = current.depth;
        uniforms.u_env_motion.value = current.motion;
        uniforms.u_env_city_lights.value = current.cityLights;
    }

    function getShaderChunk() {
        return `
            // EnvironmentSystem uniforms and procedural generators (environment.js)
            uniform float u_env_enabled;
            uniform float u_env_type;
            uniform float u_env_height;
            uniform float u_env_density;
            uniform float u_env_detail;
            uniform float u_env_depth;
            uniform float u_env_motion;
            uniform float u_env_city_lights;

            float envNoise2(vec2 p) {
                vec2 i = floor(p);
                vec2 f = fract(p);
                f = f * f * (3.0 - 2.0 * f);
                float a = hash(i);
                float b = hash(i + vec2(1.0, 0.0));
                float c = hash(i + vec2(0.0, 1.0));
                float d = hash(i + vec2(1.0, 1.0));
                return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
            }

            float envSilhouetteMask(float lineY, float pixelY) {
                return 1.0 - smoothstep(lineY - 0.0022, lineY + 0.0022, pixelY);
            }

            vec3 envWeatherFarColor(float dayFactor, float overcast, float golden) {
                vec3 day = mix(vec3(0.23, 0.31, 0.39), vec3(0.38, 0.40, 0.42), overcast * 0.72);
                day = mix(day, vec3(0.54, 0.29, 0.20), golden * (1.0 - overcast * 0.7) * 0.45);
                vec3 night = vec3(0.027, 0.043, 0.070);
                return mix(night, day, dayFactor);
            }

            vec3 envWeatherNearColor(float dayFactor, float overcast, float storm) {
                vec3 day = mix(vec3(0.085, 0.125, 0.155), vec3(0.145, 0.160, 0.180), overcast * 0.78);
                day = mix(day, vec3(0.075, 0.085, 0.105), storm * 0.62);
                vec3 night = vec3(0.008, 0.016, 0.030);
                return mix(night, day, dayFactor);
            }

            // Triangular interpolation creates broad, low-frequency rock facets instead of pixel grain.
            float envMountainFacetNoise(vec2 p) {
                vec2 cell = floor(p);
                vec2 f = fract(p);
                // Adjacent triangles share lattice vertices, so facets stay continuous across cell borders.
                float a = hash(cell + vec2(17.1, 31.7));
                float b = hash(cell + vec2(18.1, 31.7));
                float c = hash(cell + vec2(17.1, 32.7));
                float d = hash(cell + vec2(18.1, 32.7));
                if (f.x + f.y < 1.0) {
                    return a + (b - a) * f.x + (c - a) * f.y;
                }
                return d + (c - d) * (1.0 - f.x) + (b - d) * (1.0 - f.y);
            }

            // A ridge is a union of individual peaks. Each peak has its own centre, width and height.
            // That makes recognisable summits and saddles instead of a sine-wave skyline.
            float envMountainProfile(float x, float seed, float peakCount, float detail,
                                     out float faceSide, out float peakToken) {
                float gx = x * peakCount + seed;
                float firstCell = floor(gx);
                float bestProfile = 0.0;
                float bestCenter = firstCell;
                float bestToken = firstCell;

                for (int i = -2; i <= 2; i++) {
                    float id = firstCell + float(i);
                    float r0 = hash(vec2(id + seed, 3.17 + seed * 0.31));
                    float r1 = hash(vec2(id + seed, 9.71 + seed * 0.17));
                    float r2 = hash(vec2(id + seed, 14.23 + seed * 0.23));
                    float center = id + mix(0.22, 0.78, r0);
                    float halfWidth = mix(0.58, 1.02, r1);
                    float distanceToPeak = abs(gx - center);
                    float triangular = clamp(1.0 - distanceToPeak / halfWidth, 0.0, 1.0);
                    float peakSharpness = mix(0.58, 1.30, r2);
                    float shape = pow(triangular, peakSharpness);
                    float broadMass = hash(vec2(id + seed * 0.73, 4.91 + seed));
                    float peakHeight = mix(0.42, 1.0, pow(r2, 0.58)) * mix(0.78, 1.14, broadMass);
                    float candidate = shape * peakHeight;
                    if (candidate > bestProfile) {
                        bestProfile = candidate;
                        bestCenter = center;
                        bestToken = id;
                    }
                }

                // Fine ruggedness only perturbs the actual crest, never fills the valleys with noise.
                float crestNoise = envNoise2(vec2(gx * 4.6 + seed * 0.8, 21.7 + seed));
                bestProfile = clamp(bestProfile + (crestNoise - 0.5) * detail * 0.075
                                    * smoothstep(0.12, 0.72, bestProfile), 0.0, 1.0);
                faceSide = (gx < bestCenter) ? -1.0 : 1.0;
                peakToken = bestToken;
                return bestProfile;
            }

            vec3 envApplyMountains(vec3 col, vec2 uv, float envHeight, float density, float detail,
                                   float depth, float dayFactor, float overcast, float storm, float golden, float fade) {
                // Separate distant range and foreground range provide real depth and overlapping silhouettes.
                float farPeakCount = mix(4.0, 8.4, density) * mix(0.88, 1.12, detail);
                float nearPeakCount = mix(3.0, 6.1, density) * mix(0.86, 1.10, detail);
                float farSide;
                float nearSide;
                float farPeakToken;
                float nearPeakToken;
                float farProfile = envMountainProfile(uv.x, 3.71, farPeakCount, detail * 0.82, farSide, farPeakToken);
                float nearProfile = envMountainProfile(uv.x, 18.47, nearPeakCount, detail, nearSide, nearPeakToken);

                // A tiny amount of low-frequency erosion breaks perfect geometric edges without adding grain.
                float farErosion = envNoise2(vec2(uv.x * farPeakCount * 5.1 + 7.3, 5.2)) - 0.5;
                float nearErosion = envNoise2(vec2(uv.x * nearPeakCount * 6.4 + 19.1, 8.6)) - 0.5;
                farProfile = clamp(farProfile + farErosion * detail * 0.045 * smoothstep(0.18, 0.70, farProfile), 0.0, 1.0);
                nearProfile = clamp(nearProfile + nearErosion * detail * 0.060 * smoothstep(0.16, 0.68, nearProfile), 0.0, 1.0);

                float farBaseY = 0.038 + envHeight * 0.10;
                float nearBaseY = 0.021 + envHeight * 0.055;
                float farLine = farBaseY + envHeight * (0.065 + farProfile * 0.79);
                float nearLine = nearBaseY + envHeight * (0.045 + nearProfile * 1.22);

                float farMask = envSilhouetteMask(farLine, uv.y);
                float nearMask = envSilhouetteMask(nearLine, uv.y);

                float sunDirection = (u_sun_uv.x >= 0.5) ? 1.0 : -1.0;
                float sunlight = smoothstep(-0.12, 0.24, u_sun_alt) * (1.0 - storm * 0.34);
                float farFacing = clamp(0.5 + 0.5 * farSide * sunDirection, 0.0, 1.0);
                float nearFacing = clamp(0.5 + 0.5 * nearSide * sunDirection, 0.0, 1.0);
                farFacing = mix(0.47, farFacing, sunlight);
                nearFacing = mix(0.43, nearFacing, sunlight);

                // Triangulated facets are broad geological planes. Overcast weather naturally flattens contrast.
                float farFacet = envMountainFacetNoise(vec2(uv.x * farPeakCount * 3.7 + farPeakToken * 0.13,
                                                              uv.y * 16.0 + uv.x * 5.4 + 2.7));
                float nearFacet = envMountainFacetNoise(vec2(uv.x * nearPeakCount * 4.8 + nearPeakToken * 0.19,
                                                              uv.y * 20.0 + uv.x * 8.1 + 11.3));
                float farFacetContrast = mix(0.78, 1.18, farFacet);
                float nearFacetContrast = mix(0.70, 1.22, nearFacet);
                farFacetContrast = mix(1.0, farFacetContrast, detail * (1.0 - overcast * 0.72));
                nearFacetContrast = mix(1.0, nearFacetContrast, detail * (1.0 - overcast * 0.64));

                vec3 farBaseColor = envWeatherFarColor(dayFactor, overcast, golden);
                vec3 nearBaseColor = envWeatherNearColor(dayFactor, overcast, storm);
                farBaseColor = mix(farBaseColor, vec3(dot(farBaseColor, vec3(0.299, 0.587, 0.114))), overcast * 0.40);
                nearBaseColor = mix(nearBaseColor, vec3(dot(nearBaseColor, vec3(0.299, 0.587, 0.114))), overcast * 0.34);
                farBaseColor *= mix(vec3(0.72, 0.81, 0.94), vec3(1.00, 0.91, 0.78), golden * 0.68);
                nearBaseColor *= mix(vec3(0.72, 0.82, 0.91), vec3(1.00, 0.78, 0.57), golden * 0.48);
                farBaseColor *= 1.0 - storm * 0.16;
                nearBaseColor *= 1.0 - storm * 0.22;

                float farFaceLight = mix(0.56, 1.18, farFacing);
                float nearFaceLight = mix(0.43, 1.22, nearFacing);
                vec3 farColor = farBaseColor * farFaceLight * farFacetContrast;
                vec3 nearColor = nearBaseColor * nearFaceLight * nearFacetContrast;

                // Distant ridges lose contrast with distance; near terrain remains more legible.
                float farHaze = clamp(depth * (0.28 + overcast * 0.19 + u_fog * 0.58), 0.0, 0.88);
                float nearHaze = clamp(depth * (0.035 + u_fog * 0.35 + overcast * 0.035), 0.0, 0.42);
                farColor = mix(farColor, col, farHaze);
                nearColor = mix(nearColor, col, nearHaze);
                col = mix(col, farColor, farMask * fade);
                col = mix(col, nearColor, nearMask * fade);

                // A restrained crest rim catches low sunlight, without turning every ridge white.
                float farCrest = (1.0 - smoothstep(0.0015, 0.010, max(farLine - uv.y, 0.0)))
                               * farMask * smoothstep(0.62, 0.94, farProfile);
                float nearCrest = (1.0 - smoothstep(0.0015, 0.012, max(nearLine - uv.y, 0.0)))
                                * nearMask * smoothstep(0.62, 0.94, nearProfile);
                vec3 rimColor = mix(vec3(0.72, 0.80, 0.88), vec3(1.00, 0.70, 0.43), golden);
                float rimStrength = sunlight * (1.0 - overcast * 0.72) * (1.0 - storm * 0.70);
                col = mix(col, rimColor, farCrest * fade * rimStrength * farFacing * 0.14);
                col = mix(col, rimColor, nearCrest * fade * rimStrength * nearFacing * 0.18);

                // Snow is restricted to high peaks and a narrow crest band, not the entire mountain edge.
                float snowAmount = max(u_snow, u_blizzard);
                float farBelowCrest = max(farLine - uv.y, 0.0);
                float nearBelowCrest = max(nearLine - uv.y, 0.0);
                float farSnow = (1.0 - smoothstep(0.004, 0.028, farBelowCrest))
                              * farMask * smoothstep(0.66, 0.94, farProfile) * snowAmount;
                float nearSnow = (1.0 - smoothstep(0.005, 0.036, nearBelowCrest))
                               * nearMask * smoothstep(0.60, 0.92, nearProfile) * snowAmount;
                col = mix(col, vec3(0.61, 0.70, 0.79), farSnow * fade * 0.66);
                col = mix(col, vec3(0.77, 0.82, 0.87), nearSnow * fade * 0.72);

                // Dust reduces saturation and shifts exposed near slopes toward sand/ochre.
                if (u_dust > 0.01) {
                    vec3 dustRock = mix(vec3(0.30, 0.27, 0.23), vec3(0.43, 0.31, 0.20), sunlight);
                    col = mix(col, dustRock, nearMask * u_dust * fade * 0.48);
                }
                return col;
            }

            vec3 envApplyForest(vec3 col, vec2 uv, float envHeight, float density, float detail, float depth,
                                float dayFactor, float overcast, float storm, float golden, float fade) {
                float baseY = 0.035 + envHeight * 0.09;
                vec3 farTree = envWeatherFarColor(dayFactor, overcast, golden) * 0.72;
                vec3 nearTree = envWeatherNearColor(dayFactor, overcast, storm) * 0.78;
                float foliageTint = max(u_snow, u_blizzard) * 0.20;
                farTree = mix(farTree, vec3(0.35, 0.41, 0.46), foliageTint);
                nearTree = mix(nearTree, vec3(0.28, 0.34, 0.40), foliageTint);

                for (int layer = 0; layer < 3; layer++) {
                    float lf = float(layer);
                    float layerScale = (layer == 0) ? 0.52 : ((layer == 1) ? 0.76 : 1.0);
                    float count = mix(11.0, 52.0, density) * layerScale;
                    float gridX = uv.x * count + lf * 17.31;
                    float cell = floor(gridX);
                    float localX = fract(gridX);
                    float rnd = hash(vec2(cell, lf * 23.7 + 4.1));
                    float sway = sin(u_time * (0.35 + u_env_motion * 1.45) + rnd * 6.2831) * u_env_motion * 0.012 * layerScale;
                    float halfWidth = 0.29 + rnd * 0.08;
                    float crown = clamp(1.0 - abs(localX - 0.5 - sway) / halfWidth, 0.0, 1.0);
                    float crownNoise = envNoise2(vec2(gridX * (2.0 + detail * 2.0), lf + 9.2));
                    float treeHeight = envHeight * (0.20 + rnd * 0.30 + crownNoise * detail * 0.10) * layerScale;
                    float treeLine = baseY + treeHeight * crown;
                    float mask = envSilhouetteMask(treeLine, uv.y) * fade;
                    vec3 treeColor = mix(farTree, nearTree, layerScale);
                    float treeHaze = clamp(depth * (0.10 + u_fog * 0.72 + overcast * (1.0 - layerScale) * 0.20) * (1.0 - layerScale * 0.52), 0.0, 0.82);
                    treeColor = mix(treeColor, col, treeHaze);
                    col = mix(col, treeColor, mask);
                }
                return col;
            }

            vec3 envApplyCity(vec3 col, vec2 uv, float envHeight, float density, float detail, float depth,
                              float dayFactor, float overcast, float storm, float fade) {
                float baseY = 0.035 + envHeight * 0.055;
                float count = mix(12.0, 58.0, density) * mix(0.82, 1.22, detail);
                float gridX = uv.x * count;
                float buildingId = floor(gridX);
                float localX = fract(gridX);
                float rnd = hash(vec2(buildingId, 71.4));
                float variation = envNoise2(vec2(buildingId * 0.17, 12.6));
                float height = envHeight * (0.18 + rnd * 0.48 + variation * detail * 0.20);
                float topY = baseY + height;
                float bodyX = smoothstep(0.015, 0.045, localX) * (1.0 - smoothstep(0.955, 0.985, localX));
                float bodyY = smoothstep(baseY - 0.002, baseY + 0.002, uv.y) * (1.0 - smoothstep(topY - 0.002, topY + 0.002, uv.y));
                float inBuilding = bodyX * bodyY;
                vec3 dayBuilding = mix(vec3(0.17, 0.20, 0.23), vec3(0.095, 0.11, 0.13), overcast * 0.72);
                vec3 nightBuilding = vec3(0.009, 0.015, 0.026);
                vec3 buildingColor = mix(nightBuilding, dayBuilding, dayFactor);
                buildingColor = mix(buildingColor, vec3(0.055, 0.060, 0.070), storm * 0.50);
                buildingColor = mix(buildingColor, vec3(0.25, 0.29, 0.34), max(u_snow, u_blizzard) * dayFactor * 0.22);
                float cityHaze = clamp(depth * (0.10 + u_fog * 0.72 + overcast * 0.18), 0.0, 0.78);
                buildingColor = mix(buildingColor, col, cityHaze);
                col = mix(col, buildingColor, inBuilding * fade);

                float safeHeight = max(height, 0.004);
                float localY = clamp((uv.y - baseY) / safeHeight, 0.0, 1.0);
                float windowX = fract(localX * 4.0);
                float windowY = fract(localY * 8.0);
                float windowShape = step(0.16, windowX) * (1.0 - step(0.78, windowX))
                                  * step(0.14, windowY) * (1.0 - step(0.76, windowY));
                float windowCol = floor(localX * 4.0);
                float windowRow = floor(localY * 8.0);
                float windowRandom = hash(vec2(buildingId * 7.0 + windowCol, windowRow + 19.3));
                float windowsOn = step(0.42, windowRandom) * (1.0 - step(0.96, windowRandom));
                float cityNight = (1.0 - dayFactor) * u_env_city_lights;
                float windows = inBuilding * windowShape * windowsOn * cityNight * fade;
                col += windows * vec3(1.0, 0.61, 0.27) * 0.78;
                return col;
            }

            vec3 envApplyOcean(vec3 col, vec2 uv, float aspect, float envHeight, float density,
                               float detail, float motion, float dayFactor, float overcast, float storm, float fade) {
                float horizonY = 0.065 + envHeight * 0.13;
                float seaMask = envSilhouetteMask(horizonY, uv.y);
                float depth = clamp((horizonY - uv.y) / max(horizonY, 0.001), 0.0, 1.0);
                vec3 dayHorizon = mix(vec3(0.20, 0.40, 0.53), vec3(0.25, 0.31, 0.35), overcast * 0.78);
                vec3 dayDeep = mix(vec3(0.025, 0.14, 0.21), vec3(0.035, 0.075, 0.095), max(overcast, storm));
                vec3 nightHorizon = vec3(0.018, 0.045, 0.075);
                vec3 nightDeep = vec3(0.004, 0.012, 0.024);
                vec3 seaColor = mix(mix(nightHorizon, dayHorizon, dayFactor), mix(nightDeep, dayDeep, dayFactor), pow(depth, 0.72));
                float windStrength = clamp(length(u_wind) * 1.8, 0.0, 1.0);
                float waveFreq = mix(42.0, 150.0, detail) * (0.70 + density * 0.55);
                float wavePhase = u_time * (0.25 + motion * 4.5 + windStrength * 1.6) + u_wind.x * 16.0;
                float wave = sin(uv.x * waveFreq * aspect + sin(uv.y * 46.0 + wavePhase) * 1.8 + wavePhase);
                float waveLine = smoothstep(0.84, 0.98, wave) * (1.0 - depth) * (0.18 + windStrength * 0.38);
                seaColor += vec3(0.12, 0.16, 0.18) * waveLine;

                float sunReflection = exp(-abs(uv.x - u_sun_uv.x) * (7.0 + density * 18.0))
                                    * (1.0 - depth) * dayFactor * max(u_sun_alt, 0.0);
                float moonReflection = exp(-abs(uv.x - u_sun_uv.x) * (8.0 + density * 15.0))
                                     * (1.0 - depth) * (1.0 - dayFactor) * max(u_moon_alt, 0.0);
                vec3 reflectionColor = mix(vec3(1.0, 0.48, 0.24), vec3(0.72, 0.83, 0.94), smoothstep(0.0, 0.24, u_sun_alt));
                seaColor += reflectionColor * sunReflection * (0.12 + detail * 0.22);
                seaColor += vec3(0.36, 0.48, 0.63) * moonReflection * 0.10;
                seaColor = mix(seaColor, col, clamp(u_fog * u_env_depth * 0.62 + overcast * u_env_depth * 0.13, 0.0, 0.75));
                col = mix(col, seaColor, seaMask * fade);

                float horizonGlow = (1.0 - smoothstep(0.0, 0.008, abs(uv.y - horizonY))) * fade;
                col += mix(vec3(0.10, 0.15, 0.18), vec3(0.45, 0.50, 0.52), dayFactor) * horizonGlow * 0.18;
                return col;
            }

            vec3 envApply(vec3 skyColor, vec2 uv, float aspect, float dayFactor) {
                float fade = smoothstep(0.0, 0.98, u_env_enabled);
                if (fade < 0.001) return skyColor;

                float envHeight = mix(0.06, 0.34, u_env_height);
                float density = clamp(u_env_density, 0.0, 1.0);
                float detail = clamp(u_env_detail, 0.0, 1.0);
                float depth = clamp(u_env_depth, 0.0, 1.0);
                float storm = clamp(max(u_thunder, max(u_heavy_rain, u_blizzard * 0.68)), 0.0, 1.0);
                float overcast = clamp(u_cloud_cov * 0.58 + u_fog * 0.30 + u_rain * 0.12 + storm * 0.35, 0.0, 1.0);
                float golden = smoothstep(-0.16, 0.015, u_sun_alt) * (1.0 - smoothstep(0.035, 0.20, u_sun_alt));

                if (u_env_type < 1.5) {
                    return envApplyMountains(skyColor, uv, envHeight, density, detail, depth, dayFactor, overcast, storm, golden, fade);
                } else if (u_env_type < 2.5) {
                    return envApplyForest(skyColor, uv, envHeight, density, detail, depth, dayFactor, overcast, storm, golden, fade);
                } else if (u_env_type < 3.5) {
                    return envApplyCity(skyColor, uv, envHeight, density, detail, depth, dayFactor, overcast, storm, fade);
                }
                return envApplyOcean(skyColor, uv, aspect, envHeight, density, detail, u_env_motion, dayFactor, overcast, storm, fade);
            }
        `;
    }

    function getFragmentCall() {
        return 'col = envApply(col, uv, aspect, dayFactor);';
    }

    return {
        applyProperties: applyProperties,
        getUniforms: getUniforms,
        updateUniforms: updateUniforms,
        getShaderChunk: getShaderChunk,
        getFragmentCall: getFragmentCall
    };
})();
