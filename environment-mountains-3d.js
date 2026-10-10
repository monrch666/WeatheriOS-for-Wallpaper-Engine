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

    // --- True 3D mountain terrain -------------------------------------------------
    // Mountains are real indexed height-field meshes rendered into a transparent
    // render target by the EXISTING Three.js renderer. This avoids a second WebGL
    // context and lets the weather shader draw rain/snow/lightning over the terrain.
    let terrainRenderer = null;
    let terrainScene = null;
    let terrainCamera = null;
    let terrainTarget = null;
    let terrainMaterials = [];
    let terrainMeshes = [];
    let terrainLastRender = -1;
    let terrainWidth = 1;
    let terrainHeight = 1;

    const terrainUniforms = {
        uTerrainSunDir: { value: null },
        uTerrainSunAlt: { value: 0.5 },
        uTerrainDay: { value: 1.0 },
        uTerrainGolden: { value: 0.0 },
        uTerrainOvercast: { value: 0.0 },
        uTerrainStorm: { value: 0.0 },
        uTerrainFog: { value: 0.0 },
        uTerrainSnow: { value: 0.0 },
        uTerrainDust: { value: 0.0 },
        uTerrainLightning: { value: 0.0 },
        uTerrainDetail: { value: 0.65 },
        uTerrainDepth: { value: 0.70 },
        uTerrainHeight: { value: 0.35 },
        uTerrainTime: { value: 0.0 }
    };

    function terrainHash(x, z, seed = 0) {
        const v = Math.sin(x * 127.1 + z * 311.7 + seed * 74.7) * 43758.5453123;
        return v - Math.floor(v);
    }

    function terrainNoise2(x, z, seed = 0) {
        const ix = Math.floor(x), iz = Math.floor(z);
        let fx = x - ix, fz = z - iz;
        fx = fx * fx * (3 - 2 * fx);
        fz = fz * fz * (3 - 2 * fz);
        const a = terrainHash(ix, iz, seed);
        const b = terrainHash(ix + 1, iz, seed);
        const c = terrainHash(ix, iz + 1, seed);
        const d = terrainHash(ix + 1, iz + 1, seed);
        return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
    }

    function terrainFbm(x, z, seed = 0) {
        let sum = 0, amp = 0.5, norm = 0;
        for (let octave = 0; octave < 4; octave++) {
            sum += terrainNoise2(x, z, seed + octave * 13.17) * amp;
            norm += amp;
            x = x * 2.03 + 17.1;
            z = z * 2.01 - 9.2;
            amp *= 0.5;
        }
        return sum / norm;
    }

    function createMountainGeometry(options) {
        const xSegs = options.xSegs;
        const zSegs = options.zSegs;
        const width = options.width;
        const peaks = [];
        let seed = options.seed * 19.73;
        const rand = () => {
            seed += 1.0;
            return terrainHash(seed, seed * 0.713, options.seed);
        };

        for (let i = 0; i < options.peakCount; i++) {
            const base = -0.65 + (i / Math.max(1, options.peakCount - 1)) * 1.30;
            const center = base + (rand() - 0.5) * (1.30 / options.peakCount) * 0.65;
            peaks.push({
                center,
                width: (0.030 + rand() * 0.046) * (options.peakWidth || 1.0),
                height: 0.50 + Math.pow(rand(), 0.62) * 0.56,
                sharpness: 0.58 + rand() * 0.90,
                left: 0.70 + rand() * 0.62,
                right: 0.72 + rand() * 0.72
            });
        }

        const positions = new Float32Array((xSegs + 1) * (zSegs + 1) * 3);
        const elevations = new Float32Array((xSegs + 1) * (zSegs + 1));
        const indices = [];
        const detail = Math.max(0, Math.min(1, current.detail));
        const invW = 1 / width;
        let p = 0;

        for (let iz = 0; iz <= zSegs; iz++) {
            const v = iz / zSegs;
            const zBase = options.zMin + v * (options.zMax - options.zMin);
            for (let ix = 0; ix <= xSegs; ix++) {
                const u = ix / xSegs;
                // A slight deterministic vertex jitter avoids a mechanical grid/facet pattern.
                const jitterX = (ix === 0 || ix === xSegs) ? 0 : (terrainHash(ix, iz, options.seed + 3) - 0.5) * width / xSegs * 0.32;
                const jitterZ = (iz === 0 || iz === zSegs) ? 0 : (terrainHash(ix, iz, options.seed + 8) - 0.5) * (options.zMax - options.zMin) / zSegs * 0.20;
                const x = (u - 0.5) * width + jitterX;
                const z = zBase + jitterZ;
                const xn = x * invW;

                let ridge = 0.0;
                for (const peak of peaks) {
                    const dx = xn - peak.center;
                    const asymmetricWidth = peak.width * (dx < 0 ? peak.left : peak.right);
                    const d = Math.abs(dx) / asymmetricWidth;
                    if (d < 1.0) {
                        const profile = peak.height * Math.pow(Math.max(0, 1 - d), peak.sharpness);
                        ridge = Math.max(ridge, profile);
                    }
                }
                // Broad massif underneath the summits means valleys remain connected terrain,
                // while ridged erosion adds secondary spurs rather than smooth sine waves.
                const massif = 0.10 + terrainFbm(xn * 5.0 + options.seed, 3.0, options.seed) * 0.17;
                ridge = Math.max(ridge, massif * (0.50 + terrainFbm(xn * 9.0, 2.4, options.seed + 2) * 0.45));

                let falloff;
                if (z <= options.ridgeZ) {
                    const t = Math.max(0, Math.min(1, (options.ridgeZ - z) / options.backDepth));
                    falloff = 0.77 + 0.23 * (1.0 - t);
                } else {
                    const t = Math.max(0, Math.min(1, (z - options.ridgeZ) / options.frontDepth));
                    falloff = Math.pow(1.0 - t, options.slopePower || 0.88);
                }

                const broadErosion = (terrainFbm(x * 0.23 + options.seed * 2.1, z * 0.27, options.seed) - 0.5) * 2.0;
                const midErosion = (terrainFbm(x * 0.63 + 4.7, z * 0.74 - 3.1, options.seed + 7) - 0.5) * 2.0;
                const fineErosion = (terrainNoise2(x * 1.08 + 5.0, z * 1.22, options.seed + 9) - 0.5) * 2.0;
                const ruggedness = (0.08 + detail * 0.32) * broadErosion
                                 + (0.015 + detail * 0.095) * midErosion
                                 + detail * 0.025 * fineErosion;
                const h = Math.max(0.015, (ridge + ruggedness * Math.max(0.12, falloff)) * falloff * options.height);
                positions[p * 3] = x;
                positions[p * 3 + 1] = h;
                positions[p * 3 + 2] = z;
                elevations[p] = Math.max(0, Math.min(1, h / options.height));
                p++;
            }
        }

        for (let iz = 0; iz < zSegs; iz++) {
            for (let ix = 0; ix < xSegs; ix++) {
                const a = iz * (xSegs + 1) + ix;
                const b = a + 1;
                const c = a + (xSegs + 1);
                const d = c + 1;
                // Winding gives an upward-facing terrain surface.
                indices.push(a, c, b, b, c, d);
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('aTerrainElevation', new THREE.BufferAttribute(elevations, 1));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();
        geometry.computeBoundingSphere();
        return geometry;
    }

    const mountainVertexShader = `
        precision highp float;
        attribute float aTerrainElevation;
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        varying float vTerrainElevation;
        void main() {
            vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
            vTerrainPosition = position;
            // Meshes use non-uniform scale. Convert local normals back to world space
            // so their direction matches uTerrainSunDir used by the fragment shader.
            vec3 terrainScale = vec3(length(modelMatrix[0].xyz), length(modelMatrix[1].xyz), length(modelMatrix[2].xyz));
            vTerrainNormal = normalize(normal / max(terrainScale, vec3(0.0001)));
            vTerrainElevation = aTerrainElevation;
            gl_Position = projectionMatrix * mvPosition;
        }
    `;

    const mountainFragmentShader = `
        precision highp float;
        uniform vec3 uTerrainSunDir;
        uniform float uTerrainSunAlt;
        uniform float uTerrainDay;
        uniform float uTerrainGolden;
        uniform float uTerrainOvercast;
        uniform float uTerrainStorm;
        uniform float uTerrainFog;
        uniform float uTerrainSnow;
        uniform float uTerrainDust;
        uniform float uTerrainLightning;
        uniform float uTerrainDetail;
        uniform float uTerrainDepth;
        uniform float uTerrainHeight;
        uniform float uTerrainTime;
        uniform float uRangeFar;
        uniform float uRangeAlpha;
        varying vec3 vTerrainPosition;
        varying vec3 vTerrainNormal;
        varying float vTerrainElevation;

        float terrainHash(vec2 p) {
            p = fract(p * vec2(123.34, 456.21));
            p += vec2(dot(p, p + vec2(45.32)));
            return fract(p.x * p.y);
        }
        float terrainNoise(vec2 p) {
            vec2 i = floor(p), f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            float a = terrainHash(i);
            float b = terrainHash(i + vec2(1.0, 0.0));
            float c = terrainHash(i + vec2(0.0, 1.0));
            float d = terrainHash(i + vec2(1.0, 1.0));
            return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
        }
        float terrainFbm(vec2 p) {
            float sum = 0.0;
            float amp = 0.5;
            for (int i = 0; i < 4; i++) {
                sum += terrainNoise(p) * amp;
                p = p * 2.03 + vec2(17.1, 9.2);
                amp *= 0.5;
            }
            return sum / 0.9375;
        }
        void main() {
            vec3 N = normalize(vTerrainNormal);
            if (!gl_FrontFacing) N = -N;
            vec3 L = normalize(uTerrainSunDir);
            float diffuse = max(dot(N, L), 0.0);
            float broad = terrainFbm(vTerrainPosition.xz * 0.19 + vec2(7.3, 3.8));
            float medium = terrainFbm(vTerrainPosition.xz * 0.61 + vec2(18.4, -5.1));
            float fine = terrainFbm(vTerrainPosition.xz * 1.65 + vec2(-3.2, 12.4));
            float rockBands = 1.0 - smoothstep(0.04, 0.18,
                abs(sin(vTerrainPosition.y * 5.4 + broad * 2.2 + medium * 0.7)));
            float rockFace = clamp(1.0 - N.y, 0.0, 1.0);

            vec3 rockShadow = mix(vec3(0.075, 0.092, 0.115), vec3(0.18, 0.19, 0.19), broad);
            vec3 rockLight = mix(vec3(0.29, 0.30, 0.29), vec3(0.52, 0.48, 0.40), medium);
            vec3 rock = mix(rockShadow, rockLight, clamp(broad * 0.62 + medium * 0.38, 0.0, 1.0));
            rock *= mix(0.76, 1.12, fine);
            rock = mix(rock, rock * vec3(0.56, 0.62, 0.69), rockBands * rockFace * 0.42 * uTerrainDetail);
            // Long muted mineral seams give the surface scale without adding pixel-sized grain.
            float strata = smoothstep(0.78, 0.94, terrainFbm(vec2(vTerrainPosition.x * 0.12 + broad * 1.7, vTerrainPosition.y * 2.8)));
            rock *= 1.0 - strata * rockFace * 0.18 * uTerrainDetail;

            float day = clamp(uTerrainDay, 0.0, 1.0);
            float overcast = clamp(uTerrainOvercast, 0.0, 1.0);
            float storm = clamp(uTerrainStorm, 0.0, 1.0);
            vec3 sunTint = mix(vec3(0.64, 0.74, 0.93), vec3(1.0, 0.65, 0.40), uTerrainGolden);
            vec3 skyFill = mix(vec3(0.018, 0.026, 0.050), vec3(0.29, 0.37, 0.49), day);
            skyFill = mix(skyFill, vec3(0.20, 0.23, 0.27), overcast * 0.78);
            float ambient = mix(0.12, 0.39, day) + overcast * 0.13;
            float direct = diffuse * (0.12 + 0.88 * day) * (1.0 - overcast * 0.72) * (1.0 - storm * 0.70);
            vec3 color = rock * (vec3(ambient) + direct * sunTint);
            color += skyFill * (0.11 + max(N.y, 0.0) * 0.10);

            // Snow follows high alpine ridges and slightly favours upward-facing facets.
            float snowNoise = terrainFbm(vTerrainPosition.xz * 0.42 + vec2(21.0, 2.0));
            float snowLine = mix(0.83, 0.59, clamp(uTerrainSnow, 0.0, 1.0)) + (snowNoise - 0.5) * 0.12;
            float snowMask = smoothstep(snowLine - 0.045, snowLine + 0.028, vTerrainElevation)
                           * smoothstep(0.12, 0.72, N.y) * uTerrainSnow;
            float snowTexture = terrainFbm(vTerrainPosition.xz * 1.15 + vec2(3.7, 18.0));
            vec3 snowColor = mix(vec3(0.42, 0.51, 0.63), vec3(0.86, 0.90, 0.95), clamp(0.35 + diffuse * 0.42 + snowTexture * 0.22, 0.0, 1.0));
            color = mix(color, snowColor, snowMask);

            // Desert dust and storms desaturate the rock; lightning briefly lights the faces.
            vec3 dustColor = mix(vec3(0.27, 0.24, 0.19), vec3(0.43, 0.32, 0.22), day * 0.7);
            color = mix(color, dustColor * (0.55 + diffuse * 0.32), uTerrainDust * 0.62);
            color = mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))) * vec3(0.82, 0.88, 0.98), storm * 0.26);
            color += vec3(0.47, 0.58, 0.78) * uTerrainLightning * 0.85;
            color = mix(color, skyFill, clamp(uTerrainFog * (uRangeFar > 0.5 ? 0.58 : 0.23) + uTerrainDepth * uRangeFar * 0.20, 0.0, 0.78));
            float alpha = uRangeAlpha;
            gl_FragColor = vec4(max(color, vec3(0.0)), alpha);
        }
    `;

    function buildTerrainMaterial(isFar, alpha) {
        const uniforms = {};
        Object.keys(terrainUniforms).forEach((key) => { uniforms[key] = terrainUniforms[key]; });
        uniforms.uRangeFar = { value: isFar ? 1.0 : 0.0 };
        uniforms.uRangeAlpha = { value: alpha };
        return new THREE.ShaderMaterial({
            uniforms,
            vertexShader: mountainVertexShader,
            fragmentShader: mountainFragmentShader,
            transparent: alpha < 0.999,
            depthTest: true,
            depthWrite: true,
            side: THREE.DoubleSide,
            blending: THREE.NormalBlending,
            toneMapped: false
        });
    }

    function attachRenderer(renderer) {
        if (terrainRenderer === renderer && terrainTarget) return;
        terrainRenderer = renderer;
        if (!terrainUniforms.uTerrainSunDir.value) terrainUniforms.uTerrainSunDir.value = new THREE.Vector3(-0.25, 0.72, 0.55).normalize();
        terrainScene = new THREE.Scene();
        terrainScene.background = null;
        terrainCamera = new THREE.PerspectiveCamera(36, 16 / 9, 0.1, 140.0);
        terrainCamera.position.set(0.0, 5.8, 22.0);
        terrainCamera.lookAt(0.0, 2.45, -2.6);
        terrainCamera.updateProjectionMatrix();

        const farGeometry = createMountainGeometry({
            seed: 13, xSegs: 190, zSegs: 44, width: 58,
            zMin: -16.0, zMax: -7.0, ridgeZ: -12.4,
            backDepth: 4.4, frontDepth: 5.0, slopePower: 0.82,
            height: 3.35, peakCount: 17, peakWidth: 1.12
        });
        const mainGeometry = createMountainGeometry({
            seed: 29, xSegs: 238, zSegs: 76, width: 55,
            zMin: -9.0, zMax: 11.5, ridgeZ: -5.5,
            backDepth: 3.8, frontDepth: 17.0, slopePower: 0.76,
            height: 5.2, peakCount: 19, peakWidth: 1.08
        });
        const foreGeometry = createMountainGeometry({
            seed: 47, xSegs: 220, zSegs: 56, width: 58,
            zMin: -1.3, zMax: 10.0, ridgeZ: 1.2,
            backDepth: 2.0, frontDepth: 8.8, slopePower: 0.68,
            height: 1.55, peakCount: 23, peakWidth: 1.18
        });

        const farMat = buildTerrainMaterial(true, 0.73);
        const mainMat = buildTerrainMaterial(false, 0.985);
        const foreMat = buildTerrainMaterial(false, 0.995);
        const farMesh = new THREE.Mesh(farGeometry, farMat);
        const mainMesh = new THREE.Mesh(mainGeometry, mainMat);
        const foreMesh = new THREE.Mesh(foreGeometry, foreMat);
        farMesh.renderOrder = 0;
        mainMesh.renderOrder = 1;
        foreMesh.renderOrder = 2;
        terrainScene.add(farMesh, mainMesh, foreMesh);
        terrainMeshes = [farMesh, mainMesh, foreMesh];
        terrainMaterials = [farMat, mainMat, foreMat];

        terrainTarget = new THREE.WebGLRenderTarget(1, 1, {
            format: THREE.RGBAFormat,
            minFilter: THREE.LinearFilter,
            magFilter: THREE.LinearFilter,
            depthBuffer: true,
            stencilBuffer: false
        });
        terrainTarget.texture.generateMipmaps = false;
        terrainTarget.texture.name = 'EnvironmentMountainRenderTarget';
        clearMountainTarget();
    }

    function clearMountainTarget() {
        if (!terrainRenderer || !terrainTarget) return;
        const prevTarget = terrainRenderer.getRenderTarget();
        const prevColor = terrainRenderer.getClearColor(new THREE.Color()).clone();
        const prevAlpha = terrainRenderer.getClearAlpha();
        try {
            terrainRenderer.setRenderTarget(terrainTarget);
            terrainRenderer.setClearColor(0x000000, 0.0);
            terrainRenderer.clear(true, true, true);
        } finally {
            terrainRenderer.setRenderTarget(prevTarget);
            terrainRenderer.setClearColor(prevColor, prevAlpha);
        }
    }

    function resize(width, height) {
        if (!terrainTarget || !terrainCamera) return;
        const w = Math.max(1, Math.floor(width || 1));
        const h = Math.max(1, Math.floor(height || 1));
        if (w !== terrainWidth || h !== terrainHeight) {
            terrainWidth = w;
            terrainHeight = h;
            terrainTarget.setSize(w, h);
            terrainCamera.aspect = w / h;
            terrainCamera.updateProjectionMatrix();
            clearMountainTarget();
        }
    }

    function uniformValue(uniforms, key, fallback = 0) {
        const entry = uniforms && uniforms[key];
        if (!entry || entry.value === undefined || entry.value === null) return fallback;
        const value = Number(entry.value);
        return Number.isFinite(value) ? value : fallback;
    }

    function renderMountains(renderer, uniforms, timeSec) {
        if (!terrainTarget || !terrainScene || !renderer) return;
        if (current.enabled < 0.005 || current.type >= 1.5) return;
        const t = Number.isFinite(timeSec) ? timeSec : 0;
        // Terrain shading changes slowly, so 30 Hz is enough and avoids spending a full extra pass at 60/120 Hz.
        if (terrainLastRender >= 0 && t - terrainLastRender < 1 / 30) return;
        terrainLastRender = t;

        const sunAlt = uniformValue(uniforms, 'u_sun_alt', 0.4);
        const sunUV = uniforms && uniforms.u_sun_uv && uniforms.u_sun_uv.value;
        const sunX = sunUV && Number.isFinite(sunUV.x) ? sunUV.x : 0.5;
        const cloudCov = uniformValue(uniforms, 'u_cloud_cov', 0.3);
        const cloudType = uniformValue(uniforms, 'u_cloud_type', 0.0);
        const rain = Math.max(uniformValue(uniforms, 'u_rain'), uniformValue(uniforms, 'u_heavy_rain') * 0.8);
        const snow = Math.max(uniformValue(uniforms, 'u_snow'), uniformValue(uniforms, 'u_blizzard'));
        const storm = Math.max(uniformValue(uniforms, 'u_thunder'), uniformValue(uniforms, 'u_lightning') * 0.65, rain * 0.36);
        const overcast = clamp01(cloudCov * (0.35 + cloudType * 0.55) + rain * 0.16 + uniformValue(uniforms, 'u_fog') * 0.25);
        const day = clamp01((sunAlt + 0.12) / 0.40);
        const golden = clamp01(1.0 - Math.abs(sunAlt - 0.025) / 0.19) * day;
        const sunDir = terrainUniforms.uTerrainSunDir.value;
        sunDir.set((sunX - 0.5) * 1.65, Math.max(0.12, sunAlt * 1.25 + 0.35), 0.54).normalize();
        terrainUniforms.uTerrainSunAlt.value = sunAlt;
        terrainUniforms.uTerrainDay.value = day;
        terrainUniforms.uTerrainGolden.value = golden;
        terrainUniforms.uTerrainOvercast.value = overcast;
        terrainUniforms.uTerrainStorm.value = storm;
        terrainUniforms.uTerrainFog.value = uniformValue(uniforms, 'u_fog');
        terrainUniforms.uTerrainSnow.value = snow;
        terrainUniforms.uTerrainDust.value = uniformValue(uniforms, 'u_dust');
        terrainUniforms.uTerrainLightning.value = uniformValue(uniforms, 'u_lightning');
        terrainUniforms.uTerrainDetail.value = current.detail;
        terrainUniforms.uTerrainDepth.value = current.depth;
        terrainUniforms.uTerrainHeight.value = current.height;
        terrainUniforms.uTerrainTime.value = t;

        // Live generation controls: height scales relief, density changes apparent ridge frequency,
        // depth increases atmospheric separation of the distant range.
        const xScale = 1.36 - current.density * 0.68;
        const yScale = 0.55 + current.height * 1.20;
        for (const mesh of terrainMeshes) mesh.scale.set(xScale, yScale, 1.0);
        if (terrainMaterials.length > 0) {
            terrainMaterials[0].uniforms.uRangeAlpha.value = 0.88 - current.depth * 0.22;
        }

        const prevTarget = renderer.getRenderTarget();
        const prevColor = renderer.getClearColor(new THREE.Color()).clone();
        const prevAlpha = renderer.getClearAlpha();
        try {
            renderer.setRenderTarget(terrainTarget);
            renderer.setClearColor(0x000000, 0.0);
            renderer.clear(true, true, true);
            renderer.render(terrainScene, terrainCamera);
        } finally {
            renderer.setRenderTarget(prevTarget);
            renderer.setClearColor(prevColor, prevAlpha);
        }
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
            u_env_city_lights: { value: current.cityLights },
            u_env_mountain_texture: { value: terrainTarget ? terrainTarget.texture : null }
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
            uniform sampler2D u_env_mountain_texture;

            vec3 envCompositeMountainTexture(vec3 col, vec2 uv) {
                vec4 layer = texture2D(u_env_mountain_texture, uv);
                float mountainType = 1.0 - smoothstep(1.15, 1.55, u_env_type);
                float amount = clamp(u_env_enabled * mountainType * layer.a, 0.0, 1.0);
                // The render target stores RGB premultiplied by alpha due to transparent blending.
                return col * (1.0 - amount) + layer.rgb * u_env_enabled * mountainType;
            }

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
                    // Mountains are composited from the transparent Three.js terrain render target.
                    return skyColor;
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
        return 'col = envCompositeMountainTexture(col, uv);\n                col = envApply(col, uv, aspect, dayFactor);';
    }

    return {
        applyProperties: applyProperties,
        getUniforms: getUniforms,
        updateUniforms: updateUniforms,
        getShaderChunk: getShaderChunk,
        getFragmentCall: getFragmentCall,
        attachRenderer: attachRenderer,
        resize: resize,
        renderMountains: renderMountains
    };
})();
