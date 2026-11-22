import * as THREE from "three";

export type ShaderFacadeMode = "glass" | "stone" | "brick" | "silo" | "solid";
export type BuildingSliceKind = "base" | "shaft" | "crown" | "full";

export interface BuildingShaderUniforms {
  uFacadeMode: { value: number };
  uSliceKind: { value: number };
  uEmissiveScale: { value: number };
  uDataMapMix: { value: number };
}

const FACADE_MODE_NUM: Record<ShaderFacadeMode, number> = {
  glass: 0,
  stone: 1,
  brick: 2,
  silo: 3,
  solid: 4,
};

const SLICE_KIND_NUM: Record<BuildingSliceKind, number> = {
  base: 0,
  shaft: 1,
  crown: 2,
  full: 3,
};

const CITY_SHADER_KEY = "codecity-building-pbr-v1";

const VERT_PARS = /* glsl */ `
varying vec3 vCityLocalPos;
varying vec3 vCityLocalNorm;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNorm;
varying vec4 vCityInstSize;
`;

const VERT_BODY = /* glsl */ `
vCityLocalPos = transformed;
vCityLocalNorm = objectNormal;
vec4 cityWPos = vec4( transformed, 1.0 );
vec3 cityObjN = objectNormal;
vec3 cityInstScale = vec3( 1.0 );
float cityInstSeed = 0.37;
#ifdef USE_INSTANCING
  cityInstScale = vec3(
    length( instanceMatrix[0].xyz ),
    length( instanceMatrix[1].xyz ),
    length( instanceMatrix[2].xyz )
  );
  mat3 cityIm = mat3( instanceMatrix );
  vec3 cityLenSq = max( vec3( 1e-5 ), vec3(
    dot( cityIm[0], cityIm[0] ),
    dot( cityIm[1], cityIm[1] ),
    dot( cityIm[2], cityIm[2] )
  ) );
  cityObjN = cityIm * ( cityObjN / cityLenSq );
  cityWPos = instanceMatrix * cityWPos;
  cityInstSeed = fract( sin( dot( instanceMatrix[3].xz, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 );
#endif
cityWPos = modelMatrix * cityWPos;
vCityWorldPos = cityWPos.xyz;
vCityWorldNorm = normalize( ( modelMatrix * vec4( cityObjN, 0.0 ) ).xyz );
vCityInstSize = vec4( max( cityInstScale, vec3( 0.05 ) ), cityInstSeed );
`;

const FRAG_PARS = /* glsl */ `
uniform float uFacadeMode;
uniform float uSliceKind;
uniform float uEmissiveScale;
uniform float uDataMapMix;
varying vec3 vCityLocalPos;
varying vec3 vCityLocalNorm;
varying vec3 vCityWorldPos;
varying vec3 vCityWorldNorm;
varying vec4 vCityInstSize;

float cityHash21( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}

vec3 cityPerturbNormal( vec3 surfPos, vec3 surfNorm, float heightVal ) {
  vec3 dpdx = dFdx( surfPos );
  vec3 dpdy = dFdy( surfPos );
  float dhdx = dFdx( heightVal );
  float dhdy = dFdy( heightVal );
  float lx = dot( dpdx, dpdx );
  float ly = dot( dpdy, dpdy );
  if ( lx < 1e-10 || ly < 1e-10 ) return surfNorm;
  vec3 vSigmaX = dpdx * inversesqrt( lx );
  vec3 vSigmaY = dpdy * inversesqrt( ly );
  vec3 R1 = cross( vSigmaY, surfNorm );
  vec3 R2 = cross( surfNorm, vSigmaX );
  float fDet = dot( vSigmaX, R1 );
  if ( abs( fDet ) < 1e-6 ) return surfNorm;
  vec3 vGrad = sign( fDet ) * ( dhdx * R1 + dhdy * R2 );
  return normalize( abs( fDet ) * surfNorm - vGrad );
}
`;

const FRAG_FACADE_BODY = /* glsl */ `
vec3 cityWNorm = normalize( vCityWorldNorm );
float cityIsRoof = smoothstep( 0.42, 0.68, cityWNorm.y );
float cityWinMask = 0.0;
float cityRough = roughness;
float cityMetal = metalness;
float cityBump = 0.0;
vec3 cityRoomGlow = vec3( 0.0 );

vec3 cityBaseTint = diffuseColor.rgb;
float instBucket = floor( vCityInstSize.w * 128.0 + 0.5 );
float cityGroundAo = ( uSliceKind < 0.5 || uSliceKind > 2.5 )
  ? mix( 0.68, 1.0, smoothstep( 0.0, 0.72, vCityLocalPos.y ) )
  : 1.0;

if ( cityIsRoof > 0.5 ) {
  float gravel = cityHash21( floor( vCityWorldPos.xz * 3.2 ) );
  float seam = smoothstep( 0.92, 0.99, abs( sin( vCityWorldPos.x * 2.1 ) ) );
  float edgeDist = max( abs( vCityLocalPos.x ), abs( vCityLocalPos.z ) );
  float parapetShadow = mix( 1.0, 0.82, smoothstep( 0.42, 0.5, edgeDist ) );
  vec3 roofNatural = mix( cityBaseTint * 0.72, vec3( 0.42, 0.45, 0.49 ), 0.35 );
  roofNatural *= ( 0.92 + 0.14 * gravel ) * ( 1.0 - 0.08 * seam ) * parapetShadow;
  vec3 roofClay = cityBaseTint * ( 0.88 + 0.14 * gravel ) * parapetShadow;
  diffuseColor.rgb = mix( roofNatural, roofClay, uDataMapMix );
  cityRough = 0.84;
  cityMetal = 0.05;
  cityBump = gravel * 0.03;
} else if ( uFacadeMode > 3.5 ) {
  float stoneVar = cityHash21( floor( vec2( vCityWorldPos.x + vCityWorldPos.z, vCityWorldPos.y * 1.4 ) * 2.0 ) );
  float course = smoothstep( 0.9, 0.98, fract( vCityLocalPos.y * vCityInstSize.y * 1.1 ) );
  vec3 trimCol = cityBaseTint * ( 0.92 + 0.12 * stoneVar ) * ( 1.0 - 0.12 * course );
  diffuseColor.rgb = trimCol * cityGroundAo;
  cityRough = 0.72;
  cityMetal = 0.12;
  cityBump = -course * 0.04;
} else if ( uFacadeMode > 2.5 ) {
  // Ribbed industrial tank / silo
  float ang = atan( vCityLocalNorm.z, vCityLocalNorm.x );
  float rib = 0.5 + 0.5 * cos( ang * 20.0 );
  float ring = smoothstep( 0.88, 0.97, fract( vCityLocalPos.y * vCityInstSize.y * 0.95 ) );
  float shade = ( 0.92 + 0.12 * rib ) * ( 1.0 - 0.18 * ring );
  diffuseColor.rgb = cityBaseTint * shade * cityGroundAo;
  cityRough = mix( 0.36, 0.55, uDataMapMix );
  cityMetal = mix( 0.48, 0.12, uDataMapMix );
  cityBump = rib * 0.03 - ring * 0.06;
} else {
  // Architectural curtain-wall glass (0), stone ashlar (1), or industrial brick (2)
  float lotH = vCityInstSize.y;
  float storyH = uSliceKind < 0.5 ? max( 0.8, lotH ) : clamp( lotH * 0.24, 0.88, 1.38 );
  float floors = uSliceKind < 0.5 ? 1.0 : max( 1.0, floor( lotH / storyH + 0.5 ) );
  float vFloor = clamp( vCityLocalPos.y, 0.0, 0.9999 ) * floors;

  vec2 horizN = normalize( vCityLocalNorm.xz + vec2( 1e-5, 0.0 ) );
  vec2 horizT = vec2( -horizN.y, horizN.x );
  float span = mix( vCityInstSize.x, vCityInstSize.z, abs( horizN.x ) );
  float horizMeters = dot( vCityLocalPos.xz * vCityInstSize.xz, horizT );
  float targetBay = clamp( min( vCityInstSize.x, vCityInstSize.z ) * 0.28, 0.72, 1.65 );
  float bays = max( 2.0, floor( span / targetBay + 0.5 ) );
  float uBay = ( horizMeters / max( 0.2, span ) + 0.5 ) * bays;

  float fx = fract( uBay );
  float fy = fract( vFloor );
  float bayIdx = floor( uBay );
  float floorIdx = floor( vFloor );

  vec2 wMin = uSliceKind < 0.5
    ? vec2( 0.12, 0.06 )
    : ( uFacadeMode < 0.5 ? vec2( 0.07, 0.16 ) : ( uFacadeMode < 1.5 ? vec2( 0.22, 0.22 ) : vec2( 0.18, 0.20 ) ) );
  vec2 wMax = uSliceKind < 0.5
    ? vec2( 0.88, 0.82 )
    : ( uFacadeMode < 0.5 ? vec2( 0.93, 0.90 ) : ( uFacadeMode < 1.5 ? vec2( 0.78, 0.84 ) : vec2( 0.82, 0.86 ) ) );

  float inX = step( wMin.x, fx ) * step( fx, wMax.x );
  float inY = step( wMin.y, fy ) * step( fy, wMax.y );
  cityWinMask = inX * inY;

  // Industrial multi-pane factory muntins
  if ( uFacadeMode > 1.5 && uSliceKind > 0.5 ) {
    float muntinX = step( 0.055, abs( fx - 0.5 ) );
    float muntinY = step( 0.065, abs( fy - 0.53 ) );
    cityWinMask *= muntinX * muntinY;
  }

  // Wall material detail (curtain spandrel, ashlar stone blocks, or running-bond brick)
  vec3 wallCol = cityBaseTint;
  if ( uFacadeMode < 0.5 ) {
    float spandrel = step( fy, wMin.y );
    wallCol = mix( cityBaseTint * 0.78, cityBaseTint * 0.55, spandrel );
    cityRough = 0.34;
    cityMetal = 0.52;
  } else if ( uFacadeMode < 1.5 ) {
    float ashlarRow = floor( vFloor * 3.0 );
    float ashlarCol = floor( uBay * 2.0 + mod( ashlarRow, 2.0 ) * 0.5 );
    float blkVar = cityHash21( vec2( ashlarCol, ashlarRow + instBucket ) );
    float mortar = smoothstep( 0.92, 0.99, fract( vFloor * 3.0 ) );
    wallCol = cityBaseTint * ( 0.90 + 0.14 * blkVar ) * ( 1.0 - 0.12 * mortar );
    cityRough = 0.78;
    cityMetal = 0.04;
    cityBump = -mortar * 0.03;
  } else {
    float brRow = floor( vFloor * 6.0 );
    float brCol = floor( uBay * 4.0 + mod( brRow, 2.0 ) * 0.5 );
    float brVar = cityHash21( vec2( brCol, brRow + instBucket ) );
    float mortar = smoothstep( 0.86, 0.98, fract( vFloor * 6.0 ) );
    wallCol = cityBaseTint * ( 0.84 + 0.24 * brVar ) * ( 1.0 - 0.16 * mortar );
    cityRough = 0.82;
    cityMetal = 0.03;
    cityBump = -mortar * 0.04;
  }

  if ( cityWinMask > 0.5 ) {
    // Interior mapping: ray-cast virtual 3D office/living rooms behind glass
    vec2 paneUV = clamp( ( vec2( fx, fy ) - wMin ) / max( vec2( 0.05 ), wMax - wMin ), 0.002, 0.998 );
    vec3 rayW = isOrthographic
      ? normalize( vec3( -viewMatrix[0][2], -viewMatrix[1][2], -viewMatrix[2][2] ) )
      : normalize( vCityWorldPos - cameraPosition );
    vec3 wallT = abs( cityWNorm.y ) > 0.99
      ? vec3( 1.0, 0.0, 0.0 )
      : normalize( cross( vec3( 0.0, 1.0, 0.0 ), cityWNorm ) );
    vec3 wallB = normalize( cross( cityWNorm, wallT ) );
    vec3 rayRoom = vec3( dot( rayW, wallT ), dot( rayW, wallB ), max( 0.18, -dot( rayW, cityWNorm ) ) );

    vec3 posRoom = vec3( paneUV, 0.0 );
    vec3 invR = 1.0 / ( sign( rayRoom ) * max( abs( rayRoom ), vec3( 1e-4 ) ) );
    vec3 tWalls = ( step( 0.0, rayRoom ) - posRoom ) * invR;
    float tBack = 0.85 * invR.z;
    float tMin = min( min( tWalls.x, tWalls.y ), tBack );

    float roomSeed = cityHash21( vec2( bayIdx + floorIdx * 19.0, instBucket + uSliceKind * 7.0 ) );
    float roomSubSeed = cityHash21( vec2( bayIdx * 3.0 + instBucket, floorIdx * 7.0 + uSliceKind ) );
    float isLit = uSliceKind < 0.5 ? step( 0.30, roomSeed ) : step( 0.54, roomSeed );
    vec3 warmTone = mix( vec3( 0.98, 0.82, 0.48 ), vec3( 0.78, 0.90, 1.0 ), step( 0.74, roomSubSeed ) );
    if ( uFacadeMode > 1.5 ) warmTone = vec3( 1.0, 0.72, 0.38 );

    float surfaceTone = 0.65;
    vec3 roomBase = vec3( 0.16, 0.21, 0.27 );
    if ( tMin >= tBack - 0.002 ) {
      surfaceTone = 0.62;
      roomBase = mix( vec3( 0.18, 0.23, 0.30 ), warmTone * 0.65, isLit * 0.6 );
    } else if ( tWalls.y < tWalls.x ) {
      surfaceTone = rayRoom.y > 0.0 ? 0.92 : 0.36;
      roomBase = rayRoom.y > 0.0
        ? mix( vec3( 0.24, 0.28, 0.35 ), warmTone * 0.92, isLit * 0.8 )
        : mix( vec3( 0.12, 0.14, 0.18 ), warmTone * 0.36, isLit * 0.4 );
    } else {
      surfaceTone = 0.50;
      roomBase = mix( vec3( 0.14, 0.19, 0.25 ), warmTone * 0.52, isLit * 0.5 );
    }

    // Subtle Venetian blinds in upper pane of random rooms
    float hasBlinds = step( 0.58, roomSubSeed ) * step( 0.60, paneUV.y );
    float blindSlats = 0.86 + 0.14 * sin( paneUV.y * 36.0 );
    roomBase = mix( roomBase, vec3( 0.64, 0.69, 0.74 ) * blindSlats, hasBlinds * 0.52 );

    // Blend interior room through glossy tinted facade glass
    vec3 glassSurface = mix( vec3( 0.20, 0.34, 0.46 ), cityBaseTint * 0.46, 0.45 );
    vec3 glazedNatural = mix( glassSurface, roomBase, 0.64 );
    vec3 glazedClay = mix( cityBaseTint * 0.42, roomBase, 0.35 );
    diffuseColor.rgb = mix( glazedNatural, glazedClay, uDataMapMix ) * cityGroundAo;
    cityRough = mix( 0.14, 0.34, uDataMapMix );
    cityMetal = mix( 0.35, 0.08, uDataMapMix );
    cityBump = -0.10;
    cityRoomGlow = warmTone * isLit * surfaceTone * ( 1.0 - 0.45 * hasBlinds );
  } else {
    vec3 wallClay = mix( wallCol, cityBaseTint * 0.92, 0.55 );
    diffuseColor.rgb = mix( wallCol, wallClay, uDataMapMix ) * cityGroundAo;
    cityBump += 0.02;
  }
}
`;

/** Attach shared world-space facade, interior-mapping, roof separation, and ground-AO shader. */
export function applyBuildingFacadeShader(
  material: THREE.MeshStandardMaterial,
  facadeMode: ShaderFacadeMode,
  sliceKind: BuildingSliceKind,
): BuildingShaderUniforms {
  const uniforms: BuildingShaderUniforms = {
    uFacadeMode: { value: FACADE_MODE_NUM[facadeMode] },
    uSliceKind: { value: SLICE_KIND_NUM[sliceKind] },
    uEmissiveScale: { value: 0.06 },
    uDataMapMix: { value: 0.0 },
  };

  material.customProgramCacheKey = () => CITY_SHADER_KEY;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFacadeMode = uniforms.uFacadeMode;
    shader.uniforms.uSliceKind = uniforms.uSliceKind;
    shader.uniforms.uEmissiveScale = uniforms.uEmissiveScale;
    shader.uniforms.uDataMapMix = uniforms.uDataMapMix;

    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${VERT_PARS}`)
      .replace("#include <project_vertex>", `#include <project_vertex>\n${VERT_BODY}`);

    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${FRAG_PARS}`)
      .replace("#include <color_fragment>", `#include <color_fragment>\n${FRAG_FACADE_BODY}`)
      .replace(
        "#include <roughnessmap_fragment>",
        `#include <roughnessmap_fragment>\nroughnessFactor = cityRough;`,
      )
      .replace(
        "#include <metalnessmap_fragment>",
        `#include <metalnessmap_fragment>\nmetalnessFactor = cityMetal;`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>\nnormal = cityPerturbNormal( -vViewPosition, normal, cityBump );`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>\ntotalEmissiveRadiance += cityRoomGlow * uEmissiveScale * ( 1.0 - 0.55 * uDataMapMix );`,
      );
  };
  return uniforms;
}
