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

