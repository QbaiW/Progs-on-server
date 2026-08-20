const DEFAULT_STAR_COUNT = 400;
const MIN_STAR_COUNT = 1;
const MAX_STAR_COUNT = 500;
const STAR_SCALE = 0.13;
const STAR_COLLISION_RADIUS = 0.128;
const FLOAT_COLLISION_DISTANCE = 0.315;
const FLOAT_POINTER_RADIUS = 1.08;
const FLOAT_NEIGHBOR_INFLUENCE_DISTANCE = 0.72;
const FLOAT_NEIGHBOR_WAKE_MIN_SPEED = 0.018;
const FLOAT_RETURN_MAX_SPEED = 1.36;
const STAR_HIT_RADIUS_MIN = 16;
const STAR_HIT_RADIUS_MAX = 25;
const RELEASE_BATCH_SIZE = 4;
const RELEASE_BATCH_INTERVAL = 0.078;
const GALAXY_SURFACE_Y = -1.9;
const BOTTLE_MOUTH_Y = 1.56;

export const EMOTION_STYLES = Object.freeze({
  joy: Object.freeze({ level: 1, label: "开心", color: 0xf28a32 }),
  anger: Object.freeze({ level: 2, label: "生气", color: 0xf7b65f }),
  anxiety: Object.freeze({ level: 3, label: "焦虑", color: 0xf5d9a9 }),
  sadness: Object.freeze({ level: 4, label: "伤心", color: 0xfff7e8 }),
  baby: Object.freeze({ level: 5, label: "宝宝！！", color: 0x9edfff }),
  custom: Object.freeze({ level: 6, label: "自定义状态", color: 0xb9ff91 }),
});

const EMOTION_KEYS = ["joy", "anger", "anxiety", "sadness", "baby", "custom"];
const DEFAULT_EMOTION_KEYS = ["joy", "anger", "anxiety", "sadness"];
const RELEASE_EMOTION_KEYS = [...DEFAULT_EMOTION_KEYS].reverse();
const DEPENDENCY_URLS = Object.freeze({
  three: [
    "/vendor/three.module.js",
    "https://cdn.jsdelivr.net/npm/three@0.168.0/build/three.module.js",
    "https://unpkg.com/three@0.168.0/build/three.module.js",
  ],
  cannon: [
    "/vendor/cannon-es.js",
    "https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js",
    "https://unpkg.com/cannon-es@0.20.0/dist/cannon-es.js",
  ],
});

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function runtimeSeed() {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
    return values[0];
  }
  return (Date.now() ^ Math.floor(Math.random() * 0xffffffff)) >>> 0;
}

function shuffleInPlace(values, random) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
  return values;
}

function emotionKeyFrom(value, fallbackIndex = 0, total = DEFAULT_STAR_COUNT) {
  const normalized = String(value ?? "").trim().toLowerCase();
  const aliases = {
    "1": "joy",
    joy: "joy",
    happy: "joy",
    happiness: "joy",
    "开心": "joy",
    "2": "anger",
    anger: "anger",
    angry: "anger",
    "生气": "anger",
    "3": "anxiety",
    anxiety: "anxiety",
    anxious: "anxiety",
    worry: "anxiety",
    "焦虑": "anxiety",
    "4": "sadness",
    sadness: "sadness",
    sad: "sadness",
    "伤心": "sadness",
    "5": "baby",
    baby: "baby",
    "宝宝": "baby",
    "宝宝！！": "baby",
    "6": "custom",
    custom: "custom",
    "自定义": "custom",
    "自定义状态": "custom",
  };
  const fallbackLevel = Math.min(
    DEFAULT_EMOTION_KEYS.length - 1,
    Math.floor((fallbackIndex / Math.max(1, total)) * DEFAULT_EMOTION_KEYS.length),
  );
  return aliases[normalized] || DEFAULT_EMOTION_KEYS[fallbackLevel];
}

function normalizeOptions(first, second, third) {
  if (first && typeof first.WebGLRenderer === "function") {
    return { ...(third || {}), THREE: first, CANNON: second };
  }
  if (first && typeof first.getContext === "function") {
    return { ...(second || {}), canvas: first };
  }
  return first || {};
}

async function importWithFallback(urls) {
  let lastError;
  for (const url of urls) {
    try {
      return await import(url);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Unable to load a 3D dependency.");
}

export class StarBottleScene {
  constructor(first, second, third) {
    const options = normalizeOptions(first, second, third);
    this.options = options;
    this.THREE = options.THREE || null;
    this.CANNON = options.CANNON || null;
    this.canvas = options.canvas;
    this.onSelect = options.onSelect || options.onStarSelect || (() => {});
    this.onPourChange =
      options.onPourChange || options.onPour || options.onOpen || (() => {});
    this.onEmotionAnchors =
      options.onEmotionAnchors || options.onBubblePositions || options.onBubbleAnchors || null;
    this.onStarDragStart = options.onStarDragStart || (() => {});
    this.onStarDragMove = options.onStarDragMove || (() => {});
    this.onStarDragEnd = options.onStarDragEnd || (() => {});

    if (!this.canvas) throw new Error("StarBottleScene requires a canvas element.");

    const configuredCount = Number(
      options.starCount ?? options.count ?? options.maxStars ?? options.config?.starCount,
    );
    this.configuredStarCount = Number.isFinite(configuredCount)
      ? clamp(Math.round(configuredCount), MIN_STAR_COUNT, MAX_STAR_COUNT)
      : null;
    this.pendingNotes = Array.isArray(options.notes) ? options.notes : [];
    this.starCount = this._resolveStarCount(this.pendingNotes);

    this.destroyed = false;
    this.initialized = false;
    this.elapsed = 0;
    this.lastFrame = 0;
    this.pourState = "sealed";
    this.openStartedAt = 0;
    this.hoveredIndex = -1;
    this.selectedIndex = -1;
    this.selectionStartedAt = 0;
    this.records = [];
    this.releaseQueue = [];
    this.releaseCursor = 0;
    this.bottleColliders = [];
    this.noteIndex = new Map();
    this.anchorIndices = {};
    this.focusTimer = null;
    this.focusResolve = null;
    this.emotionFilter = null;
    this.pendingOpen = false;
    this.pendingFocus = null;
    this.lastAnchorEmit = 0;
    this.pointerWorld = null;
    this.viewYaw = 0;
    this.viewPitch = 0;
    this.presentationPitch = 0.035;
    this.cameraDistance = 9.7;
    this.dragPointerId = null;
    this.dragStart = null;
    this.dragLast = null;
    this.isDragging = false;
    this.dragMode = null;
    this.pressedTarget = null;
    this.draggedStarIndex = -1;
    this.dragStarted = false;
    this.dragInitialPosition = null;
    this.starDragEnabled = true;
    this.interactionLocked = false;
    this.visualClaims = new Map();
    this.heartArrayOverride = null;
    // The pet is rendered as a 2D sprite, but its anchor lives on the same
    // galaxy ground plane as the stars.  Keeping this state in the scene
    // lets the regular floating-field collision pass push stars around it.
    this.petWorldPosition = null;
    this.petWorldVelocity = null;
    this.petCollisionRadius = 0.34;
    this.petCollisionEnabled = false;
    this.petPositionUpdatedAt = 0;
    this.petSprite = null;
    this.petSpriteVisible = false;
    this.petSpritePose = "idle";
    this.petSpriteWalking = false;
    this.petSpriteDirection = "right";
    this.petTextureCache = new Map();
    this.petTextureRequest = 0;
    this.pointerType = "mouse";
    this.bottleRetired = false;
    const configuredLayoutSeed = Number(options.layoutSeed);
    this.layoutSeed = Number.isFinite(configuredLayoutSeed)
      ? Math.floor(configuredLayoutSeed) >>> 0
      : runtimeSeed();
    this._random = seededRandom(917204);
    this.ready = this._initialize(options);
  }

  _resolveStarCount(notes) {
    if (this.configuredStarCount) return this.configuredStarCount;
    if (Array.isArray(notes) && notes.length >= MIN_STAR_COUNT) {
      return clamp(notes.length, MIN_STAR_COUNT, MAX_STAR_COUNT);
    }
    return DEFAULT_STAR_COUNT;
  }

  async _initialize() {
    const [THREE, CANNON] = await Promise.all([
      this.THREE ? Promise.resolve(this.THREE) : importWithFallback(DEPENDENCY_URLS.three),
      this.CANNON ? Promise.resolve(this.CANNON) : importWithFallback(DEPENDENCY_URLS.cannon),
    ]);
    if (this.destroyed) return this;

    this.THREE = THREE;
    this.CANNON = CANNON;
    this.pointerDirty = false;
    this.pointer = new THREE.Vector2(2, 2);
    this.lastFrame = performance.now();
    this._setupRenderer();
    this._setupWorld();
    this._createNightSky();
    this._createBottle();
    this._createStars(this.pendingNotes);
    this._bindEvents();
    this.initialized = true;
    this.resize();

    this._frame = this._frame.bind(this);
    this.animationFrame = requestAnimationFrame(this._frame);
    this._installDebugSurface();

    if (this.emotionFilter) this.setEmotionFilter(this.emotionFilter);
    if (this.pendingFocus) {
      const pending = this.pendingFocus;
      this.pendingFocus = null;
      this.pendingOpen = false;
      this.focusStar(pending.id, pending.options);
    } else if (this.pendingOpen) {
      this.openBottle();
    }
    return this;
  }

  init() {
    return this.ready;
  }

  _setupRenderer() {
    const THREE = this.THREE;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x02040b);
    this.scene.fog = new THREE.FogExp2(0x02040b, 0.023);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 90);
    this.camera.position.set(0, 0.08, 9.7);
    this.cameraTarget = new THREE.Vector3(0, -0.1, 0);
    this.cameraDesiredPosition = new THREE.Vector3(0, 0.08, 9.7);
    this.camera.lookAt(this.cameraTarget);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.7));
    if (THREE.SRGBColorSpace) this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    if (THREE.ACESFilmicToneMapping) {
      this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
      this.renderer.toneMappingExposure = 1.26;
    }

    this.raycaster = new THREE.Raycaster();
    this.instanceDummy = new THREE.Object3D();
    this.statusMarkerDummy = new THREE.Object3D();
    this.tempColor = new THREE.Color();
    this.highlightColor = new THREE.Color(0xffffff);
    this._tmpVector = new THREE.Vector3();
    this._tmpVector2 = new THREE.Vector3();
    this._tmpQuaternion = new THREE.Quaternion();
    this._tmpQuaternion2 = new THREE.Quaternion();
    this._floatPointerVector = new THREE.Vector3();
    this._pickProjection = new THREE.Vector3();
    this._floatPlane = new THREE.Plane(
      new THREE.Vector3(0, 1, 0),
      -GALAXY_SURFACE_Y,
    );
    this._floatEuler = new THREE.Euler();
    this._floatQuaternion = new THREE.Quaternion();
    this._waveNormal = new THREE.Vector3();
    this._worldUp = new THREE.Vector3(0, 1, 0);
    this._bottleWorldQuaternion = new THREE.Quaternion();
    this._bottleInverseQuaternion = new THREE.Quaternion();
    this._physicsLocalPosition = new THREE.Vector3();
    this._physicsWorldPosition = new THREE.Vector3();
    this._physicsLocalVelocity = new THREE.Vector3();
    this._physicsWorldVelocity = new THREE.Vector3();
    this.petWorldVelocity = new THREE.Vector3();

    this.scene.add(new THREE.HemisphereLight(0xb8c9ff, 0x170e10, 1.55));
    this.scene.add(new THREE.AmbientLight(0xffead3, 1.65));

    const warmLight = new THREE.PointLight(0xff9c4a, 22, 11, 1.75);
    warmLight.position.set(-3.8, -0.4, 4.8);
    this.scene.add(warmLight);

    const coolLight = new THREE.PointLight(0x9cbcff, 17, 12, 1.8);
    coolLight.position.set(3.6, 4.4, 5.4);
    this.scene.add(coolLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 2.25);
    rimLight.position.set(-4.5, 5.8, 4.2);
    this.scene.add(rimLight);

    this._createPetSprite();
  }

  _createPetSprite() {
    const THREE = this.THREE;
    this.petTextureLoader = new THREE.TextureLoader();
    const material = new THREE.SpriteMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      alphaTest: 0.025,
      depthTest: true,
      depthWrite: false,
    });
    this.petSprite = new THREE.Sprite(material);
    this.petSprite.name = "galaxy-pet";
    this.petSprite.visible = false;
    this.petSprite.renderOrder = 4;
    this.petSprite.scale.set(0.76, 0.76, 1);
    this.scene.add(this.petSprite);
    this.setPetSpritePose("idle", "/pet/idle.png");
  }

  setPetSpritePose(pose = "idle", assetUrl = "") {
    this.petSpritePose = String(pose || "idle");
    const url = String(assetUrl || "").trim();
    if (!url || !this.petTextureLoader || !this.petSprite?.material) return false;
    const request = ++this.petTextureRequest;
    const install = (texture) => {
      if (!texture || request !== this.petTextureRequest || !this.petSprite?.material) return;
      if (this.THREE.SRGBColorSpace) texture.colorSpace = this.THREE.SRGBColorSpace;
      texture.needsUpdate = true;
      this.petSprite.material.map = texture;
      this.petSprite.material.needsUpdate = true;
    };
    const cached = this.petTextureCache.get(url);
    if (cached) {
      install(cached);
      return true;
    }
    this.petTextureLoader.load(url, (texture) => {
      this.petTextureCache.set(url, texture);
      install(texture);
    }, undefined, () => {});
    return true;
  }

  setPetSpriteVisible(visible = true) {
    this.petSpriteVisible = Boolean(visible);
    if (this.petSprite) this.petSprite.visible = this.petSpriteVisible && Boolean(this.petWorldPosition);
    return this.petSpriteVisible;
  }

  setPetWalking(active = false, direction = "right") {
    this.petSpriteWalking = Boolean(active);
    this.petSpriteDirection = String(direction).toLowerCase() === "left" ? "left" : "right";
    return this.petSpriteWalking;
  }

  _updatePetSprite() {
    if (!this.petSprite || !this.petWorldPosition) return;
    const baseWidth = 0.76;
    const baseHeight = 0.76;
    const phase = this.elapsed * 12;
    const bob = this.petSpriteWalking ? Math.abs(Math.sin(phase)) * 0.055 : 0;
    const squash = this.petSpriteWalking ? Math.sin(phase * 2) * 0.018 : 0;
    this.petSprite.position.set(
      this.petWorldPosition.x,
      this.petWorldPosition.y + baseHeight * 0.5 + bob,
      this.petWorldPosition.z,
    );
    this.petSprite.scale.set(
      (this.petSpriteDirection === "left" ? -1 : 1) * (baseWidth + squash),
      baseHeight - squash,
      1,
    );
    this.petSprite.material.rotation = this.petSpriteWalking ? Math.sin(phase) * 0.035 : 0;
    this.petSprite.visible = this.petSpriteVisible;
  }

  _setupWorld() {
    const CANNON = this.CANNON;
    if (!CANNON) {
      this.world = null;
      return;
    }

    this.world = new CANNON.World({ gravity: new CANNON.Vec3(0, 0, 0) });
    this.world.allowSleep = true;
    this.world.solver.iterations = 15;
    this.world.solver.tolerance = 0.0005;
    if (CANNON.SAPBroadphase) this.world.broadphase = new CANNON.SAPBroadphase(this.world);

    this.starPhysicsMaterial = new CANNON.Material("folded-paper");
    this.surfacePhysicsMaterial = new CANNON.Material("glass-and-ground");
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.starPhysicsMaterial, this.surfacePhysicsMaterial, {
        friction: 0.28,
        restitution: 0.035,
        contactEquationStiffness: 9e6,
        contactEquationRelaxation: 4,
      }),
    );
    this.world.addContactMaterial(
      new CANNON.ContactMaterial(this.starPhysicsMaterial, this.starPhysicsMaterial, {
        friction: 0.16,
        restitution: 0.025,
      }),
    );

    const ground = new CANNON.Body({
      mass: 0,
      material: this.surfacePhysicsMaterial,
      collisionFilterGroup: 2,
      collisionFilterMask: 1,
    });
    ground.addShape(new CANNON.Box(new CANNON.Vec3(10, 0.08, 3.3)));
    ground.position.set(0.5, -2.61, 0);
    this.world.addBody(ground);
    this.groundBody = ground;
  }

  _createNightSky() {
    const THREE = this.THREE;
    const random = seededRandom(43581);

    const makeStars = (count, spread, size, opacity, color) => {
      const positions = new Float32Array(count * 3);
      for (let index = 0; index < count; index += 1) {
        const offset = index * 3;
        positions[offset] = (random() - 0.5) * spread;
        positions[offset + 1] = (random() - 0.42) * spread * 0.58;
        positions[offset + 2] = -3 - random() * 15;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({
        color,
        size,
        sizeAttenuation: true,
        transparent: true,
        opacity,
        depthWrite: false,
      });
      const points = new THREE.Points(geometry, material);
      this.scene.add(points);
      return points;
    };

    this.skyNear = makeStars(410, 22, 0.033, 0.72, 0xfff3df);
    this.skyFar = makeStars(900, 31, 0.017, 0.43, 0xb7c8ff);

    const groundMaterial = new THREE.MeshStandardMaterial({
      color: 0x070912,
      roughness: 0.9,
      metalness: 0.08,
      transparent: true,
      opacity: 0.82,
    });
    this.groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(32, 13), groundMaterial);
    this.groundMesh.rotation.x = -Math.PI / 2;
    this.groundMesh.position.set(0.5, -2.51, -0.1);
    this.scene.add(this.groundMesh);

    const surfaceMaterial = new THREE.MeshPhysicalMaterial({
      color: 0x172331,
      roughness: 0.28,
      metalness: 0.2,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      clearcoat: 0.7,
      clearcoatRoughness: 0.25,
      side: THREE.DoubleSide,
    });
    this.galaxySurface = new THREE.Mesh(
      new THREE.PlaneGeometry(14, 8, 1, 1),
      surfaceMaterial,
    );
    this.galaxySurface.rotation.x = -Math.PI / 2;
    this.galaxySurface.position.set(0.8, GALAXY_SURFACE_Y - 0.18, 0);
    this.galaxySurface.visible = false;
    this.galaxySurface.renderOrder = 1;
    this.scene.add(this.galaxySurface);
  }

  _createBottle() {
    const THREE = this.THREE;
    this.bottleGroup = new THREE.Group();
    this.scene.add(this.bottleGroup);

    const profile = [
      [1.16, -2.31],
      [1.28, -2.27],
      [1.37, -2.11],
      [1.38, 0.66],
      [1.34, 0.82],
      [1.23, 0.98],
      [1.05, 1.12],
      [1.04, 1.48],
      [1.12, BOTTLE_MOUTH_Y],
      [0.98, BOTTLE_MOUTH_Y],
      [0.94, 1.48],
      [0.94, 1.16],
      [1.10, 1.02],
      [1.22, 0.84],
      [1.25, 0.65],
      [1.25, -2.03],
      [1.15, -2.18],
    ].map((pair) => new THREE.Vector2(pair[0], pair[1]));

    const glassMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xc7deea,
      roughness: 0.055,
      metalness: 0,
      transmission: 0.92,
      transparent: true,
      opacity: 0.2,
      thickness: 0.28,
      ior: 1.47,
      clearcoat: 1,
      clearcoatRoughness: 0.045,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    this.glassMesh = new THREE.Mesh(new THREE.LatheGeometry(profile, 72), glassMaterial);
    this.glassMesh.renderOrder = 8;
    this.bottleGroup.add(this.glassMesh);

    const baseMaterial = glassMaterial.clone();
    baseMaterial.opacity = 0.31;
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(1.27, 1.19, 0.12, 72),
      baseMaterial,
    );
    base.position.y = -2.22;
    base.renderOrder = 9;
    this.bottleGroup.add(base);

    const rimMaterial = new THREE.MeshPhysicalMaterial({
      color: 0xe9f8ff,
      transparent: true,
      opacity: 0.52,
      roughness: 0.035,
      transmission: 0.74,
      depthWrite: false,
    });
    const topRim = new THREE.Mesh(new THREE.TorusGeometry(1.055, 0.075, 12, 72), rimMaterial);
    topRim.rotation.x = Math.PI / 2;
    topRim.position.y = BOTTLE_MOUTH_Y - 0.01;
    topRim.renderOrder = 10;
    this.bottleGroup.add(topRim);

    const lowerRim = new THREE.Mesh(new THREE.TorusGeometry(0.985, 0.028, 9, 64), rimMaterial);
    lowerRim.rotation.x = Math.PI / 2;
    lowerRim.position.y = BOTTLE_MOUTH_Y - 0.17;
    lowerRim.renderOrder = 10;
    this.bottleGroup.add(lowerRim);

    const highlightMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.32,
      depthWrite: false,
    });
    const highlightPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.92, -1.86, 1.0),
      new THREE.Vector3(-1.12, -0.7, 1.03),
      new THREE.Vector3(-1.08, 0.45, 1.02),
      new THREE.Vector3(-0.88, 0.8, 0.88),
      new THREE.Vector3(-0.69, 1.08, 0.67),
      new THREE.Vector3(-0.67, 1.47, 0.65),
    ]);
    const highlight = new THREE.Mesh(
      new THREE.TubeGeometry(highlightPath, 44, 0.021, 6, false),
      highlightMaterial,
    );
    highlight.renderOrder = 11;
    this.bottleGroup.add(highlight);

    this._createCork();
    if (this.world) this._createBottleColliders();
  }

  _createCork() {
    const THREE = this.THREE;
    this.corkGroup = new THREE.Group();
    this.corkGroup.position.set(0, BOTTLE_MOUTH_Y + 0.2, 0);
    this.corkGroup.userData.cork = true;
    this.bottleGroup.add(this.corkGroup);

    const corkMaterial = new THREE.MeshStandardMaterial({
      color: 0xa9653d,
      roughness: 0.94,
      metalness: 0,
    });
    this.corkMesh = new THREE.Mesh(
      new THREE.CylinderGeometry(1.055, 1.005, 0.42, 48, 4),
      corkMaterial,
    );
    this.corkMesh.userData.cork = true;
    this.corkGroup.add(this.corkMesh);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(1.14, 1.1, 0.14, 56, 2),
      corkMaterial,
    );
    cap.position.y = 0.25;
    cap.userData.cork = true;
    this.corkGroup.add(cap);

    const grainMaterial = new THREE.MeshBasicMaterial({
      color: 0x704027,
      transparent: true,
      opacity: 0.42,
    });
    for (const y of [-0.14, -0.01, 0.13, 0.27]) {
      const grain = new THREE.Mesh(new THREE.TorusGeometry(1.025, 0.009, 4, 48), grainMaterial);
      grain.rotation.x = Math.PI / 2;
      grain.position.y = y;
      grain.userData.cork = true;
      this.corkGroup.add(grain);
    }
  }

  _createBottleColliders() {
    const CANNON = this.CANNON;
    const definitions = [
      { p: [0, -2.11, 0], h: [1.24, 0.11, 0.95], r: 0 },
      { p: [-1.29, -0.695, 0], h: [0.1, 1.39, 1.0], r: 0 },
      { p: [1.29, -0.695, 0], h: [0.1, 1.39, 1.0], r: 0 },
      { p: [0, -0.695, -0.96], h: [1.28, 1.39, 0.085], r: 0 },
      { p: [0, -0.695, 0.96], h: [1.28, 1.39, 0.085], r: 0 },
      { p: [-1.19, 0.91, 0], h: [0.16, 0.31, 1.0], r: -0.46 },
      { p: [1.19, 0.91, 0], h: [0.16, 0.31, 1.0], r: 0.46 },
      { p: [-0.985, 1.32, 0], h: [0.09, 0.25, 1.0], r: 0 },
      { p: [0.985, 1.32, 0], h: [0.09, 0.25, 1.0], r: 0 },
      { p: [0, 1.32, -0.96], h: [0.98, 0.25, 0.085], r: 0 },
      { p: [0, 1.32, 0.96], h: [0.98, 0.25, 0.085], r: 0 },
    ];

    for (const definition of definitions) {
      const body = new CANNON.Body({
        type: CANNON.Body.KINEMATIC,
        mass: 0,
        material: this.surfacePhysicsMaterial,
        collisionFilterGroup: 2,
        collisionFilterMask: 1,
      });
      body.addShape(new CANNON.Box(new CANNON.Vec3(...definition.h)));
      const localQuaternion = new CANNON.Quaternion();
      localQuaternion.setFromEuler(0, 0, definition.r);
      this.world.addBody(body);
      this.bottleColliders.push({
        body,
        localPosition: new CANNON.Vec3(...definition.p),
        localQuaternion,
      });
    }
    this._syncBottleColliders();
  }

  _makeStarGeometry() {
    const THREE = this.THREE;
    const positions = [];
    const colors = [];
    const indices = [];
    const perimeterCount = 60;
    const frontInner = [];
    const frontMiddle = [];
    const frontEdge = [];
    const backInner = [];
    const backMiddle = [];
    const backEdge = [];
    const addVertex = (x, y, z, shade) => {
      positions.push(x, y, z);
      colors.push(shade, shade, shade);
      return positions.length / 3 - 1;
    };

    const frontCenter = addVertex(0, 0, 0.51, 1);
    const backCenter = addVertex(0, 0, -0.49, 0.6);
    for (let index = 0; index < perimeterCount; index += 1) {
      // Half-step sampling puts two vertices around each tip, producing the
      // softly rounded ends visible on a real puffed lucky star.
      const angle = Math.PI / 2 + ((index + 0.5) * Math.PI * 2) / perimeterCount;
      const tipness = (Math.cos((angle - Math.PI / 2) * 5) + 1) * 0.5;
      const roundedTipness = smoothstep(Math.pow(tipness, 0.78));
      const radius = 0.57 + roundedTipness * 0.43;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius;
      const lobeShade = 0.91 + Math.sin(angle * 2.5 - 0.4) * 0.055;
      const foldShade = lobeShade - (1 - roundedTipness) * 0.08;
      frontInner.push(
        addVertex(x * 0.31, y * 0.31, 0.465 + roundedTipness * 0.012, foldShade),
      );
      frontMiddle.push(
        addVertex(x * 0.68, y * 0.68, 0.27 + roundedTipness * 0.018, foldShade * 0.96),
      );
      frontEdge.push(addVertex(x, y, 0.015, foldShade * 0.86));
      backInner.push(
        addVertex(x * 0.31, y * 0.31, -0.445 - roundedTipness * 0.012, 0.66),
      );
      backMiddle.push(
        addVertex(x * 0.68, y * 0.68, -0.255 - roundedTipness * 0.018, 0.61),
      );
      backEdge.push(addVertex(x, y, -0.015, 0.56 + roundedTipness * 0.035));
    }

    for (let index = 0; index < perimeterCount; index += 1) {
      const next = (index + 1) % perimeterCount;
      indices.push(frontCenter, frontInner[index], frontInner[next]);
      indices.push(frontInner[index], frontMiddle[index], frontMiddle[next]);
      indices.push(frontInner[index], frontMiddle[next], frontInner[next]);
      indices.push(frontMiddle[index], frontEdge[index], frontEdge[next]);
      indices.push(frontMiddle[index], frontEdge[next], frontMiddle[next]);

      indices.push(backCenter, backInner[next], backInner[index]);
      indices.push(backInner[index], backMiddle[next], backMiddle[index]);
      indices.push(backInner[index], backInner[next], backMiddle[next]);
      indices.push(backMiddle[index], backEdge[next], backEdge[index]);
      indices.push(backMiddle[index], backMiddle[next], backEdge[next]);

      indices.push(frontEdge[index], backEdge[index], backEdge[next]);
      indices.push(frontEdge[index], backEdge[next], frontEdge[next]);
    }

    const creaseProfile = [
      { radius: 0.07, z: 0.514, width: 0.006 },
      { radius: 0.175, z: 0.471, width: 0.008 },
      { radius: 0.385, z: 0.276, width: 0.011 },
      { radius: 0.565, z: 0.02, width: 0.014 },
    ];
    for (let fold = 0; fold < 5; fold += 1) {
      const angle = Math.PI / 2 + Math.PI / 5 + (fold * Math.PI * 2) / 5;
      const directionX = Math.cos(angle);
      const directionY = Math.sin(angle);
      const perpendicularX = -directionY;
      const perpendicularY = directionX;
      for (let segment = 0; segment < creaseProfile.length - 1; segment += 1) {
        const start = creaseProfile[segment];
        const end = creaseProfile[segment + 1];
        const startLeft = addVertex(
          directionX * start.radius + perpendicularX * start.width,
          directionY * start.radius + perpendicularY * start.width,
          start.z + 0.006,
          0.72,
        );
        const startRight = addVertex(
          directionX * start.radius - perpendicularX * start.width,
          directionY * start.radius - perpendicularY * start.width,
          start.z + 0.006,
          0.72,
        );
        const endRight = addVertex(
          directionX * end.radius - perpendicularX * end.width,
          directionY * end.radius - perpendicularY * end.width,
          end.z + 0.006,
          0.76,
        );
        const endLeft = addVertex(
          directionX * end.radius + perpendicularX * end.width,
          directionY * end.radius + perpendicularY * end.width,
          end.z + 0.006,
          0.76,
        );
        indices.push(startLeft, startRight, endRight, startLeft, endRight, endLeft);
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  _normalizeNotes(notes, count = this.starCount) {
    const source = Array.isArray(notes) ? notes.slice(0, count) : [];
    const usedIds = new Set();
    const normalized = source.map((note, index) => {
      const value = note && typeof note === "object" ? note : { text: String(note ?? "") };
      const emotion = emotionKeyFrom(
        value.emotion ?? value.mood ?? value.level ?? value.emotionLevel,
        index,
        count,
      );
      let id = String(value.id ?? value.noteId ?? ("star-" + String(index + 1).padStart(3, "0")));
      if (usedIds.has(id)) id += "-copy-" + String(index + 1);
      usedIds.add(id);
      return {
        ...value,
        id,
        text: String(
          value.text ?? value.content ?? value.body ?? (EMOTION_STYLES[emotion].label + "的纸条"),
        ),
        emotion,
        emotionLabel: emotion === "custom"
          ? String(value.emotionLabel || EMOTION_STYLES.custom.label).slice(0, 24)
          : EMOTION_STYLES[emotion].label,
        customPosition: emotion === "custom" && value.customPosition === "right" ? "right" : "left",
        changeStatus: value.changeStatus === "unread" ? "unread" : "read",
        changeReason: ["added", "updated", "manual"].includes(value.changeReason)
          ? value.changeReason
          : "",
        _sourceOrder: index,
      };
    });

    for (let index = normalized.length; index < count; index += 1) {
      const emotion = emotionKeyFrom("", index, count);
      let id = "star-" + String(index + 1).padStart(3, "0");
      while (usedIds.has(id)) id += "-extra";
      usedIds.add(id);
      normalized.push({
        id,
        text: EMOTION_STYLES[emotion].label + "的纸条",
        emotion,
        emotionLabel: EMOTION_STYLES[emotion].label,
        customPosition: "left",
        changeStatus: "read",
        changeReason: "",
        _sourceOrder: index,
      });
    }

    return normalized;
  }

  _packPositions(count) {
    const positions = [];
    const random = seededRandom(248117);
    const spacing = 0.276;
    const rowSpacing = spacing * Math.sqrt(3) * 0.5;
    const layerSpacing = spacing * Math.sqrt(2 / 3);
    const bottomCenter = -1.965;
    const minimumDistanceSquared = 0.262 * 0.262;

    for (let layer = 0; layer < 18 && positions.length < count; layer += 1) {
      const candidates = [];
      const layerXOffset = (layer % 2) * spacing * 0.5;
      const layerZOffset = (layer % 2) * rowSpacing / 3;
      for (let row = -5; row <= 5; row += 1) {
        for (let column = -6; column <= 6; column += 1) {
          const x =
            column * spacing +
            (row & 1 ? spacing * 0.5 : 0) +
            layerXOffset +
            (random() - 0.5) * 0.008;
          const z = row * rowSpacing + layerZOffset + (random() - 0.5) * 0.008;
          const yJitter = layer === 0 ? random() * 0.002 : (random() - 0.5) * 0.008;
          const y = bottomCenter + layer * layerSpacing + yJitter;
          const ellipse = (x * x) / (1.08 * 1.08) + (z * z) / (0.77 * 0.77);
          if (ellipse > 1) continue;
          candidates.push({ x, y, z, layer });
        }
      }

      for (let index = candidates.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [candidates[index], candidates[swapIndex]] = [candidates[swapIndex], candidates[index]];
      }

      for (const candidate of candidates) {
        if (positions.length >= count) break;
        const clear = positions.every((position) => {
          const dx = position.x - candidate.x;
          const dy = position.y - candidate.y;
          const dz = position.z - candidate.z;
          return dx * dx + dy * dy + dz * dz >= minimumDistanceSquared;
        });
        if (clear) positions.push(candidate);
      }
    }

    if (positions.length < count) {
      throw new Error("Unable to pack the requested number of stars without overlap.");
    }
    return positions.slice(0, count);
  }

  _buildGalaxyTargets(count) {
    const width = Math.max(1, this.canvas.clientWidth || globalThis.innerWidth || 1280);
    const height = Math.max(1, this.canvas.clientHeight || globalThis.innerHeight || 720);
    const aspect = clamp(width / height, 0.5, 2.4);
    const layoutAspect = aspect < 0.78 ? 0.78 : clamp(aspect * 1.2, 1.08, 2.2);
    const fieldArea = count * FLOAT_COLLISION_DISTANCE ** 2 * 1.45;
    const fieldWidth = Math.sqrt(fieldArea * layoutAspect);
    const fieldDepth = fieldArea / fieldWidth;
    const centerX = aspect < 0.78 ? 0.12 : 0.86;
    const random = seededRandom((this.layoutSeed ^ (count * 7919) ^ 31847) >>> 0);
    const points = [];

    const makeCandidate = () => {
      const normalizedX = random() * 2 - 1;
      const x = centerX + normalizedX * fieldWidth * 0.5;
      const depthEnvelope = 0.82 + Math.cos(normalizedX * Math.PI * 0.5) * 0.18;
      const centerLine = Math.sin(normalizedX * Math.PI * 1.35 + 0.28) * fieldDepth * 0.075;
      const z = centerLine + (random() * 2 - 1) * fieldDepth * 0.5 * depthEnvelope;
      return { x, z };
    };

    // Deterministic best-candidate sampling gives a natural scatter without
    // visible rows. A final uniform expansion guarantees the pick clearance.
    for (let index = 0; index < count; index += 1) {
      let best = null;
      let bestDistanceSquared = -1;
      const candidateCount = index < 24 ? 64 : 46;
      for (let candidateIndex = 0; candidateIndex < candidateCount; candidateIndex += 1) {
        const candidate = makeCandidate();
        let nearestDistanceSquared = Infinity;
        for (const point of points) {
          const dx = candidate.x - point.x;
          const dz = candidate.z - point.z;
          nearestDistanceSquared = Math.min(nearestDistanceSquared, dx * dx + dz * dz);
          if (nearestDistanceSquared <= bestDistanceSquared) break;
        }
        if (nearestDistanceSquared > bestDistanceSquared) {
          best = candidate;
          bestDistanceSquared = nearestDistanceSquared;
        }
      }
      points.push(best || makeCandidate());
    }

    let actualMinimumSquared = Infinity;
    for (let first = 0; first < points.length; first += 1) {
      for (let second = first + 1; second < points.length; second += 1) {
        const dx = points[first].x - points[second].x;
        const dz = points[first].z - points[second].z;
        actualMinimumSquared = Math.min(actualMinimumSquared, dx * dx + dz * dz);
      }
    }
    const actualMinimum = Math.sqrt(actualMinimumSquared);
    const spacingScale = Number.isFinite(actualMinimum) && actualMinimum > 0
      ? Math.max(1, (FLOAT_COLLISION_DISTANCE * 1.025) / actualMinimum)
      : 1;
    if (spacingScale > 1) {
      for (const point of points) {
        point.x = centerX + (point.x - centerX) * spacingScale;
        point.z *= spacingScale;
      }
    }

    const minX = Math.min(...points.map((point) => point.x));
    const maxX = Math.max(...points.map((point) => point.x));
    const minZ = Math.min(...points.map((point) => point.z));
    const maxZ = Math.max(...points.map((point) => point.z));
    this.galaxyCenterX = (minX + maxX) * 0.5;
    this.galaxyCenterZ = (minZ + maxZ) * 0.5;
    this.galaxyHalfWidth = Math.max(1, (maxX - minX) * 0.5 + 0.35);
    this.galaxyHalfDepth = Math.max(1, (maxZ - minZ) * 0.5 + 0.35);
    if (this.galaxySurface) {
      this.galaxySurface.position.x = (minX + maxX) * 0.5;
      this.galaxySurface.position.z = (minZ + maxZ) * 0.5;
      this.galaxySurface.scale.set(
        ((maxX - minX) + 0.9) / 14,
        ((maxZ - minZ) + 0.9) / 8,
        1,
      );
    }

    return points.map((point) => new this.THREE.Vector3(
      point.x,
      GALAXY_SURFACE_Y +
        Math.sin(point.x * 0.82 + point.z * 0.31) * 0.038 +
        Math.cos(point.z * 1.36 - point.x * 0.19) * 0.022,
      point.z,
    ));
  }

  _buildReleaseQueue(records) {
    const buckets = Object.fromEntries(EMOTION_KEYS.map((key) => [key, []]));
    for (const record of records) buckets[record.emotion].push(record);
    const random = seededRandom((this.layoutSeed ^ 0x7f4a7c15) >>> 0);
    for (const bucket of Object.values(buckets)) {
      bucket.sort((left, right) => {
        const heightDifference = right.localPosition.y - left.localPosition.y;
        if (Math.abs(heightDifference) > 0.001) return heightDifference;
        return right.localPosition.x - left.localPosition.x || left.index - right.index;
      });
      shuffleInPlace(bucket, random);
    }

    const regularQueue = [];
    for (const emotion of RELEASE_EMOTION_KEYS) {
      regularQueue.push(...buckets[emotion]);
    }

    const queue = [];
    const specialQueue = [];
    while (buckets.baby.length || buckets.custom.length) {
      const customRecord = buckets.custom.shift();
      if (customRecord) specialQueue.push(customRecord);
      const babyRecord = buckets.baby.shift();
      if (babyRecord) specialQueue.push(babyRecord);
    }
    let specialCursor = 0;
    for (let regularCursor = 0; regularCursor <= regularQueue.length; regularCursor += 1) {
      while (
        specialCursor < specialQueue.length &&
        Math.floor(((specialCursor + 1) * (regularQueue.length + 1)) / (specialQueue.length + 1)) <=
          regularCursor
      ) {
        queue.push(specialQueue[specialCursor]);
        specialCursor += 1;
      }
      if (regularCursor < regularQueue.length) queue.push(regularQueue[regularCursor]);
    }
    return queue;
  }

  _assignGalaxyTargets(records, targets) {
    const assignments = new Map();
    if (!records.length || !targets.length) return assignments;

    const minX = Math.min(...targets.map((target) => target.x));
    const maxX = Math.max(...targets.map((target) => target.x));
    const minZ = Math.min(...targets.map((target) => target.z));
    const maxZ = Math.max(...targets.map((target) => target.z));
    const width = Math.max(0.1, maxX - minX);
    const depth = Math.max(0.1, maxZ - minZ);
    const centerX = (minX + maxX) * 0.5;
    const centerZ = (minZ + maxZ) * 0.5;
    const random = seededRandom((this.layoutSeed ^ (records.length * 313) ^ 59341) >>> 0);
    let available = targets.map((target) => ({
      target,
      regionNoise: (random() - 0.5) * width * 0.16,
      orderNoise: (random() - 0.5) * depth * 0.08,
    }));
    const buckets = Object.fromEntries(EMOTION_KEYS.map((key) => [key, []]));
    for (const record of records) buckets[record.emotion].push(record);

    const pairWithinRegion = (bucket, slots) => {
      const shuffledRecords = shuffleInPlace([...bucket], random);
      const shuffledSlots = shuffleInPlace([...slots], random);
      shuffledRecords.forEach((record, index) => {
        assignments.set(record, shuffledSlots[index].target);
      });
    };

    available.sort(
      (left, right) =>
        left.target.x + left.regionNoise - (right.target.x + right.regionNoise),
    );

    const customLeft = buckets.custom.filter((record) => record.customPosition !== "right");
    const customRight = buckets.custom.filter((record) => record.customPosition === "right");
    if (customLeft.length) {
      pairWithinRegion(customLeft, available.splice(0, customLeft.length));
    }
    if (buckets.baby.length) {
      pairWithinRegion(buckets.baby, available.splice(0, buckets.baby.length));
    }
    if (customRight.length) {
      pairWithinRegion(
        customRight,
        available.splice(Math.max(0, available.length - customRight.length), customRight.length),
      );
    }

    let cursor = 0;
    for (const key of DEFAULT_EMOTION_KEYS) {
      const bucket = buckets[key];
      const slots = available.slice(cursor, cursor + bucket.length);
      cursor += bucket.length;
      pairWithinRegion(bucket, slots);
    }
    return assignments;
  }

  _relayoutGalaxyTargets(preserveRelativePosition = true) {
    if (!this.releaseQueue.length) return;
    const targets = this._buildGalaxyTargets(this.starCount);
    const assignments = this._assignGalaxyTargets(this.releaseQueue, targets);
    this.releaseQueue.forEach((record) => {
      const previousTarget = record.targetPosition;
      const nextTarget = assignments.get(record);
      if (!nextTarget) return;
      if (preserveRelativePosition && record.state === "floating" && previousTarget) {
        record.position.add(nextTarget).sub(previousTarget);
      }
      record.targetPosition = nextTarget;
    });
  }

  _prepareReleasePlan({ refreshSeed = false } = {}) {
    if (refreshSeed) this.layoutSeed = runtimeSeed();
    this.releaseQueue = this._buildReleaseQueue(this.records);
    this.releaseQueue.forEach((record, rank) => {
      record.releaseRank = rank;
      record.releaseAt = 1.7 + Math.floor(rank / RELEASE_BATCH_SIZE) * RELEASE_BATCH_INTERVAL;
    });
    const galaxyTargets = this._buildGalaxyTargets(this.starCount);
    const assignments = this._assignGalaxyTargets(this.releaseQueue, galaxyTargets);
    this.releaseQueue.forEach((record, rank) => {
      record.targetPosition = assignments.get(record) || galaxyTargets[rank];
    });
    this.finalReleaseAt = this.releaseQueue.at(-1)?.releaseAt ?? 1.7;
    this.releaseCursor = 0;
  }

  _createStars(notes) {
    const THREE = this.THREE;
    this.notes = this._normalizeNotes(notes, this.starCount);
    this.emotionColors = Object.fromEntries(
      EMOTION_KEYS.map((key) => [key, new THREE.Color(EMOTION_STYLES[key].color)]),
    );
    this.filterDimColor = new THREE.Color(0x10121a);

    const geometry = this._makeStarGeometry();
    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 0.76,
      metalness: 0,
      flatShading: false,
    });
    this.starMesh = new THREE.InstancedMesh(geometry, material, this.starCount);
    this.starMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.starMesh.frustumCulled = false;
    this.starMesh.renderOrder = 3;
    this.scene.add(this.starMesh);

    this.statusMarkerMesh = new THREE.InstancedMesh(
      new THREE.OctahedronGeometry(0.055, 0),
      new THREE.MeshBasicMaterial({
        color: 0x9fe0bb,
        transparent: true,
        opacity: 0.92,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
      this.starCount,
    );
    this.statusMarkerMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.statusMarkerMesh.frustumCulled = false;
    this.statusMarkerMesh.renderOrder = 6;
    this.scene.add(this.statusMarkerMesh);

    this.selectionHalo = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.selectionHalo.visible = false;
    this.selectionHalo.renderOrder = 5;
    this.scene.add(this.selectionHalo);

    this.selectionRing = new THREE.Mesh(
      new THREE.RingGeometry(1.06, 1.19, 48),
      new THREE.MeshBasicMaterial({
        color: 0xfff4d3,
        transparent: true,
        opacity: 0.72,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.selectionRing.visible = false;
    this.selectionRing.renderOrder = 4;
    this.scene.add(this.selectionRing);

    const packedPositions = this._packPositions(this.starCount);
    const packedRandom = seededRandom(83377 + this.starCount * 37);
    for (let index = packedPositions.length - 1; index > 0; index -= 1) {
      const swapIndex = Math.floor(packedRandom() * (index + 1));
      [packedPositions[index], packedPositions[swapIndex]] = [
        packedPositions[swapIndex],
        packedPositions[index],
      ];
    }
    for (let index = 0; index < this.starCount; index += 1) {
      const note = this.notes[index];
      const packed = packedPositions[index];
      const random = seededRandom(7103 + index * 997);
      const quaternion = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(
          (random() - 0.5) * 1.35,
          random() * Math.PI * 2,
          (random() - 0.5) * 1.25,
        ),
      );
      const faceUpQuaternion = new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0),
        -Math.PI / 2,
      );
      const targetQuaternion = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 1, 0), random() * Math.PI * 2)
        .multiply(faceUpQuaternion);
      const localPosition = new THREE.Vector3(packed.x, packed.y, packed.z);
      const record = {
        index,
        note,
        emotion: note.emotion,
        customPosition: note.customPosition === "right" ? "right" : "left",
        initialPosition: { x: packed.x, y: packed.y, z: packed.z },
        localPosition,
        position: localPosition.clone(),
        localQuaternion: quaternion.clone(),
        quaternion: quaternion.clone(),
        targetQuaternion,
        targetPosition: null,
        body: null,
        state: "contained",
        frozen: false,
        escaped: false,
        releaseRank: 0,
        releaseAt: 0,
        physicsStartedAt: 0,
        physicsDuration: 1.42,
        mouthPlanePosition: null,
        mouthOutward: null,
        flowBias: random(),
        flowStart: null,
        flowStartQuaternion: null,
        mouthPass: null,
        exitPosition: null,
        exitStartedAt: 0,
        exitDuration: 0,
        galaxyStart: null,
        galaxyStartQuaternion: null,
        galaxyStartedAt: 0,
        galaxyDuration: 1.46,
        floatVelocity: new THREE.Vector3(),
        floatPhase: random() * Math.PI * 2,
        floatFrequency: 0.72 + random() * 0.3,
      };

      if (this.world) {
        const CANNON = this.CANNON;
        const body = new CANNON.Body({
          type: CANNON.Body.KINEMATIC,
          mass: 0,
          material: this.starPhysicsMaterial,
          linearDamping: 0.34,
          angularDamping: 0.58,
          allowSleep: true,
          sleepSpeedLimit: 0.045,
          sleepTimeLimit: 0.5,
          collisionFilterGroup: 1,
          collisionFilterMask: 3,
        });
        body.addShape(
          new CANNON.Box(
            new CANNON.Vec3(
              STAR_COLLISION_RADIUS,
              STAR_COLLISION_RADIUS,
              STAR_COLLISION_RADIUS * 0.82,
            ),
          ),
        );
        body.position.set(packed.x, packed.y, packed.z);
        body.quaternion.set(quaternion.x, quaternion.y, quaternion.z, quaternion.w);
        this.world.addBody(body);
        record.body = body;
      }
      this.records.push(record);
    }

    this._prepareReleasePlan();
    this._rebuildNoteIndex();
    this._refreshStarColors();
    this._syncContainedStars();
    this._updateStarMatrices();
  }

  _disposeStars() {
    this.visualClaims.clear();
    this.heartArrayOverride = null;
    if (!this.starMesh) return;
    this.scene.remove(this.starMesh);
    this.scene.remove(this.statusMarkerMesh);
    this.scene.remove(this.selectionHalo);
    this.scene.remove(this.selectionRing);
    this.starMesh.geometry.dispose();
    this.starMesh.material.dispose();
    this.statusMarkerMesh?.geometry.dispose();
    this.statusMarkerMesh?.material.dispose();
    this.selectionHalo?.material.dispose();
    this.selectionRing?.geometry.dispose();
    this.selectionRing?.material.dispose();
    if (this.world) {
      for (const record of this.records) {
        if (record.body) this.world.removeBody(record.body);
      }
    }
    this.starMesh = null;
    this.statusMarkerMesh = null;
    this.selectionHalo = null;
    this.selectionRing = null;
    this.records.length = 0;
    this.releaseQueue.length = 0;
    this.noteIndex.clear();
  }

  _pruneVisualOverrides() {
    for (const [id, claim] of this.visualClaims) {
      const record = this._recordForNoteId(id);
      if (!record || record.index !== claim.index || record.state !== "floating") {
        this.visualClaims.delete(id);
      }
    }
    if (!this.heartArrayOverride) return;
    for (const index of this.heartArrayOverride.positions.keys()) {
      const record = this.records[index];
      if (!record || record.state !== "floating") {
        this.heartArrayOverride.positions.delete(index);
        this.heartArrayOverride.bases.delete(index);
      }
    }
    if (!this.heartArrayOverride.positions.size) this.heartArrayOverride = null;
  }

  _rebuildNoteIndex() {
    this.noteIndex.clear();
    this.anchorIndices = {};
    this.records.forEach((record, index) => {
      const id = String(record.note.id);
      if (!this.noteIndex.has(id)) this.noteIndex.set(id, index);
      if (this.anchorIndices[record.emotion] === undefined) {
        this.anchorIndices[record.emotion] = index;
      }
    });
  }

  setNotes(notes) {
    this.pendingNotes = Array.isArray(notes) ? notes : [];
    if (!this.initialized) return this.pendingNotes;

    const requestedCount = this._resolveStarCount(this.pendingNotes);
    if (requestedCount !== this.starCount) {
      const previousPourState = this.pourState;
      const selectedId = this.records[this.selectedIndex]?.note?.id || null;
      this._disposeStars();
      this.starCount = requestedCount;
      this._createStars(this.pendingNotes);
      this.hoveredIndex = -1;
      this.selectedIndex = selectedId && this.noteIndex.has(selectedId)
        ? this.noteIndex.get(selectedId)
        : -1;
      if (previousPourState !== "sealed") {
        this.releaseCursor = this.releaseQueue.length;
        for (const record of this.records) this._beginFloatingRecord(record);
        if (this.world) this.world.gravity.set(0, 0, 0);
        this._retireBottleColliders();
        this.bottleGroup.visible = false;
        this.corkGroup.visible = false;
        if (this.galaxySurface) {
          this.galaxySurface.visible = true;
          this.galaxySurface.material.opacity = 0.13;
        }
        this.pourState = "settled";
        if (previousPourState !== "settled") {
          this.onPourChange({ phase: "settled", opened: true, progress: 1 });
        }
      }
      this._updateStarMatrices();
      return this.notes;
    }

    const normalized = this._normalizeNotes(this.pendingNotes, this.starCount);
    this.notes = normalized;
    for (let index = 0; index < this.records.length; index += 1) {
      const note = normalized[index];
      const record = this.records[index];
      record.note = note;
      record.emotion = note.emotion;
      record.customPosition = note.customPosition === "right" ? "right" : "left";
    }
    if (this.pourState === "sealed") {
      this._prepareReleasePlan();
    } else {
      this._relayoutGalaxyTargets(false);
    }
    this._rebuildNoteIndex();
    this._pruneVisualOverrides();
    this._refreshStarColors();
    return this.notes;
  }

  updateNotes(notes) {
    return this.setNotes(notes);
  }

  setEmotionFilter(key = null) {
    const nextFilter = key && EMOTION_STYLES[key] ? key : null;
    this.emotionFilter = nextFilter;
    if (this.initialized) this._refreshStarColors();
    return this.emotionFilter;
  }

  _refreshStarColors() {
    if (!this.starMesh) return;
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      const filteredOut = this.emotionFilter && record.emotion !== this.emotionFilter;
      const noteColor = String(record.note.color || "").trim();
      if (/^#[0-9a-f]{6}$/i.test(noteColor)) this.tempColor.set(noteColor);
      else this.tempColor.copy(this.emotionColors[record.emotion]);
      if (filteredOut) this.tempColor.lerp(this.filterDimColor, 0.78);
      if (record.note.changeStatus === "unread" && !filteredOut) {
        this.tempColor.lerp(this.highlightColor, 0.1);
      }
      if (index === this.hoveredIndex) this.tempColor.lerp(this.highlightColor, 0.48);
      if (index === this.selectedIndex) this.tempColor.lerp(this.highlightColor, 0.26);
      this.starMesh.setColorAt(index, this.tempColor);
    }
    if (this.starMesh.instanceColor) this.starMesh.instanceColor.needsUpdate = true;
  }

  _setPointerFromEvent(event) {
    const rect = this.canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.pointerType = event.pointerType || this.pointerType;
    this.pointerDirty = true;
    return true;
  }

  _positionObject(position) {
    if (!position) return null;
    return {
      x: Number(position.x) || 0,
      y: Number(position.y) || 0,
      z: Number(position.z) || 0,
    };
  }

  _positionVector(position) {
    if (!position || !this.THREE) return null;
    const x = Number(position.x);
    const y = Number(position.y);
    const z = Number(position.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    return new this.THREE.Vector3(x, y, z);
  }

  _baseWorldPositionForRecord(record) {
    if (!record) return null;
    if (record.state === "physics" && record.body) {
      return new this.THREE.Vector3(
        record.body.position.x,
        record.body.position.y,
        record.body.position.z,
      );
    }
    return record.position || null;
  }

  _visualOverrideForRecord(record) {
    if (!record || record.state !== "floating") return null;
    const claim = this.visualClaims.get(String(record.note.id));
    if (claim?.index === record.index) return claim.position;
    const heartPosition = this.heartArrayOverride?.positions?.get(record.index);
    return heartPosition || null;
  }

  _displayPositionForRecord(record) {
    return this._visualOverrideForRecord(record) || this._baseWorldPositionForRecord(record);
  }

  _dragCurrentPosition(record) {
    if (!record) return null;
    if (this.pointerWorld && record.state === "floating") {
      const position = this.pointerWorld.clone();
      // Floating stars follow the pointer on the field plane with a small
      // lift, matching the existing drag motion.
      const liftedY = Number(record.targetPosition?.y) + 0.11;
      if (Number.isFinite(liftedY)) position.y = liftedY;
      return position;
    }
    return this._displayPositionForRecord(record);
  }

  _emitStarDrag(callback, record, currentPosition) {
    if (!record || record.state !== "floating" || !record.targetPosition) return;
    const current = currentPosition || this._displayPositionForRecord(record);
    if (!current) return;
    const target = record.targetPosition;
    const payload = {
      noteId: String(record.note.id),
      index: record.index,
      currentPosition: current.clone(),
      targetPosition: target.clone(),
      distanceFromTarget: current.distanceTo(target),
    };
    try {
      callback(payload);
    } catch (error) {
      // A consumer callback must not stop the render loop or pointer cleanup.
      console.error("Star drag callback failed:", error);
    }
  }

  _emitStarDragStart(record, currentPosition) {
    if (!record || record.state !== "floating" || !record.targetPosition) return;
    const current = currentPosition || this._displayPositionForRecord(record);
    if (!current) return;
    const payload = {
      noteId: String(record.note.id),
      index: record.index,
      startPosition: current.clone(),
      targetPosition: record.targetPosition.clone(),
    };
    try {
      this.onStarDragStart(payload);
    } catch (error) {
      console.error("Star drag start callback failed:", error);
    }
  }

  _emitStarDragMove(record, currentPosition) {
    this._emitStarDrag(this.onStarDragMove, record, currentPosition);
  }

  _emitStarDragEnd(record, currentPosition) {
    this._emitStarDrag(this.onStarDragEnd, record, currentPosition);
  }

  _bindEvents() {
    this._onPointerMove = (event) => {
      if (!this._setPointerFromEvent(event)) return;
      if (this.dragPointerId !== event.pointerId || !this.dragLast) return;

      const totalX = event.clientX - this.dragStart.x;
      const totalY = event.clientY - this.dragStart.y;
      if (!this.isDragging && Math.hypot(totalX, totalY) > 5) {
        this.isDragging = true;
        const draggedRecord = this.records[this.draggedStarIndex];
        if (this.dragMode === "star" && draggedRecord?.state === "floating") {
          this._updatePointerWorld();
          this.dragStarted = true;
          this._emitStarDragStart(
            draggedRecord,
            this.dragInitialPosition || this._dragCurrentPosition(draggedRecord),
          );
        }
      }
      if (this.isDragging) {
        if (this.dragMode === "camera") {
          const deltaX = event.clientX - this.dragLast.x;
          const deltaY = event.clientY - this.dragLast.y;
          this.viewYaw = clamp(this.viewYaw - deltaX * 0.0042, -0.58, 0.58);
          this.viewPitch = clamp(this.viewPitch - deltaY * 0.0035, -0.2, 0.28);
          this.pointerWorld = null;
          this._setHovered(-1);
        } else if (this.dragMode === "star" && this.dragStarted) {
          this._updatePointerWorld();
          this._emitStarDragMove(
            this.records[this.draggedStarIndex],
            this._dragCurrentPosition(this.records[this.draggedStarIndex]),
          );
        }
        this.canvas.style.cursor = "grabbing";
      }
      this.dragLast.x = event.clientX;
      this.dragLast.y = event.clientY;
    };
    this._onPointerLeave = () => {
      if (this.dragPointerId !== null) return;
      this.pointer.set(2, 2);
      this.pointerDirty = false;
      this.pointerWorld = null;
      this._setHovered(-1);
    };
    this._onPointerDown = (event) => {
      if (!this.starDragEnabled || this.interactionLocked) return;
      if (this.dragPointerId !== null || !this._setPointerFromEvent(event)) return;
      this.dragPointerId = event.pointerId;
      this.dragStart = { x: event.clientX, y: event.clientY };
      this.dragLast = { x: event.clientX, y: event.clientY };
      this.isDragging = false;
      this.dragStarted = false;
      this.pressedTarget = this._pick();
      const pressedRecord =
        typeof this.pressedTarget === "number" ? this.records[this.pressedTarget] : null;
      this.dragMode = pressedRecord?.state === "floating" ? "star" : "camera";
      this.draggedStarIndex = this.dragMode === "star" ? this.pressedTarget : -1;
      this.dragInitialPosition = this.dragMode === "star"
        ? this._displayPositionForRecord(pressedRecord)?.clone() || null
        : null;
      try {
        this.canvas.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is optional; mouse input still works without it.
      }
    };
    this._onPointerUp = (event) => {
      if (this.dragPointerId !== event.pointerId) return;
      this._setPointerFromEvent(event);
      const activate = !this.isDragging;
      const draggedStarIndex = this.draggedStarIndex;
      const pressedTarget = this.pressedTarget;
      const draggedRecord = this.records[draggedStarIndex];
      if (this.isDragging && this.dragMode === "star" && this.dragStarted) {
        this._updatePointerWorld();
        this._emitStarDragEnd(draggedRecord, this._dragCurrentPosition(draggedRecord));
      }
      try {
        if (this.canvas.hasPointerCapture(event.pointerId)) {
          this.canvas.releasePointerCapture(event.pointerId);
        }
      } catch {
        // The pointer may already have been released by the browser.
      }
      this.dragPointerId = null;
      this.dragStart = null;
      this.dragLast = null;
      this.isDragging = false;
      this.dragMode = null;
      this.pressedTarget = null;
      this.draggedStarIndex = -1;
      this.dragStarted = false;
      this.dragInitialPosition = null;

      if (draggedStarIndex >= 0) {
        this.records[draggedStarIndex]?.floatVelocity.set(0, 0, 0);
      }

      if (activate) {
        const releasedTarget = this._pick();
        const target =
          pressedTarget === "cork" || Number.isInteger(pressedTarget)
            ? pressedTarget
            : releasedTarget;
        if (target === "cork") {
          this.openBottle();
        } else if (typeof target === "number" && this.pourState !== "sealed") {
          this._selectIndex(target, "pointer");
        }
      }
      const hoveredRecord = this.records[this.hoveredIndex];
      this.canvas.style.cursor = hoveredRecord?.state === "floating"
        ? "grab"
        : this.hoveredIndex >= 0
          ? "pointer"
          : "grab";
    };
    this._onPointerCancel = (event) => {
      if (this.dragPointerId !== event.pointerId) return;
      const draggedRecord = this.records[this.draggedStarIndex];
      if (this.isDragging && this.dragMode === "star" && this.dragStarted) {
        this._updatePointerWorld();
        this._emitStarDragEnd(draggedRecord, this._dragCurrentPosition(draggedRecord));
      }
      this.dragPointerId = null;
      this.dragStart = null;
      this.dragLast = null;
      this.isDragging = false;
      this.dragMode = null;
      this.pressedTarget = null;
      this.draggedStarIndex = -1;
      this.dragStarted = false;
      this.dragInitialPosition = null;
      this.canvas.style.cursor = "grab";
    };
    this._onWindowResize = () => this.resize();

    this.canvas.addEventListener("pointermove", this._onPointerMove, { passive: true });
    this.canvas.addEventListener("pointerleave", this._onPointerLeave, { passive: true });
    this.canvas.addEventListener("pointerdown", this._onPointerDown, { passive: true });
    this.canvas.addEventListener("pointerup", this._onPointerUp, { passive: true });
    this.canvas.addEventListener("pointercancel", this._onPointerCancel, { passive: true });
    this.canvas.style.cursor = "grab";
    globalThis.addEventListener("resize", this._onWindowResize, { passive: true });

    if (globalThis.ResizeObserver) {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.canvas);
    }
  }

  setStarDragEnabled(enabled = true) {
    this.starDragEnabled = Boolean(enabled);
    return this.starDragEnabled;
  }

  setInteractionLocked(locked = false) {
    this.interactionLocked = Boolean(locked);
    if (this.interactionLocked && this.dragPointerId !== null) {
      this.dragPointerId = null;
      this.dragStart = null;
      this.dragLast = null;
      this.isDragging = false;
      this.dragMode = null;
      this.pressedTarget = null;
      this.draggedStarIndex = -1;
      this.dragStarted = false;
      this.dragInitialPosition = null;
      this.canvas.style.cursor = "default";
    }
    return this.interactionLocked;
  }

  _pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    if (this.pourState === "sealed") {
      const corkHit = this.raycaster.intersectObject(this.corkGroup, true)[0];
      return corkHit ? "cork" : null;
    }
    if (this.pourState === "settled") return this._pickNearestStar();
    const starHit = this.raycaster
      .intersectObject(this.starMesh, false)
      .find((hit) => this._isStarPickable(hit.instanceId));
    if (starHit) return starHit.instanceId;
    return this._pickNearestStar();
  }

  _isStarPickable(index) {
    if (!Number.isInteger(index) || this.pourState === "sealed") return false;
    const record = this.records[index];
    if (!record || record.state === "contained") return false;
    return !this.emotionFilter || record.emotion === this.emotionFilter;
  }

  _starHitRadius(rect, multiplier = 1) {
    const base = clamp(
      Math.min(rect.width, rect.height) * 0.027,
      STAR_HIT_RADIUS_MIN,
      STAR_HIT_RADIUS_MAX,
    );
    const inputScale = this.pointerType === "touch" ? 1.28 : 1;
    return base * inputScale * multiplier;
  }

  _pointerDistanceSquared(index, rect = this.canvas.getBoundingClientRect()) {
    if (!this._isStarPickable(index) || !rect.width || !rect.height) return Infinity;
    const record = this.records[index];
    if (record.state === "physics" && record.body) {
      this._pickProjection.set(
        record.body.position.x,
        record.body.position.y,
        record.body.position.z,
      );
    } else {
      this._pickProjection.copy(this._displayPositionForRecord(record) || record.position);
    }
    this._pickProjection.project(this.camera);
    if (this._pickProjection.z < -1 || this._pickProjection.z > 1) return Infinity;

    const pointerX = (this.pointer.x * 0.5 + 0.5) * rect.width;
    const pointerY = (-this.pointer.y * 0.5 + 0.5) * rect.height;
    const starX = (this._pickProjection.x * 0.5 + 0.5) * rect.width;
    const starY = (-this._pickProjection.y * 0.5 + 0.5) * rect.height;
    const dx = starX - pointerX;
    const dy = starY - pointerY;
    return dx * dx + dy * dy;
  }

  _pickNearestStar() {
    const rect = this.canvas.getBoundingClientRect();
    const radius = this._starHitRadius(rect);
    let nearestIndex = null;
    let nearestDistanceSquared = radius * radius;
    for (const record of this.records) {
      const distanceSquared = this._pointerDistanceSquared(record.index, rect);
      if (distanceSquared <= nearestDistanceSquared) {
        nearestDistanceSquared = distanceSquared;
        nearestIndex = record.index;
      }
    }
    return nearestIndex;
  }

  _setHovered(index) {
    if (this.hoveredIndex === index) return;
    const previousRecord = this.records[this.hoveredIndex];
    if (previousRecord) previousRecord.frozen = false;
    this.hoveredIndex = index;
    const hoveredRecord = index >= 0 ? this.records[index] : null;
    if (hoveredRecord?.state === "floating") {
      hoveredRecord.frozen = true;
      hoveredRecord.floatVelocity.set(0, 0, 0);
    }
    this.canvas.style.cursor = this.isDragging
      ? "grabbing"
      : hoveredRecord?.state === "floating"
        ? "grab"
        : index === -2 && this.pourState === "sealed"
          ? "pointer"
          : index >= 0
            ? "pointer"
            : "grab";
    if (this.initialized) this._refreshStarColors();
  }

  _updateHover() {
    if (!this.pointerDirty || this.isDragging) return;
    if (this.hoveredIndex >= 0) {
      const rect = this.canvas.getBoundingClientRect();
      const releaseRadius = this._starHitRadius(rect, 1.16);
      if (this._pointerDistanceSquared(this.hoveredIndex, rect) <= releaseRadius * releaseRadius) {
        return;
      }
    }
    const target = this._pick();
    if (target === "cork") this._setHovered(-2);
    else if (typeof target === "number") this._setHovered(target);
    else this._setHovered(-1);
  }

  _updatePointerWorld() {
    const draggingStar = this.isDragging && this.dragMode === "star";
    if (!this.pointerDirty || (this.isDragging && !draggingStar) || this.pourState !== "settled") {
      this.pointerWorld = null;
      return;
    }
    this.raycaster.setFromCamera(this.pointer, this.camera);
    this.pointerWorld =
      this.raycaster.ray.intersectPlane(this._floatPlane, this._floatPointerVector) || null;
  }

  /**
   * Convert viewport coordinates to the same ground plane used by the
   * floating stars.  This is intentionally public so the DOM pet can be
   * dragged without taking ownership of Three.js internals.
   */
  getGalaxyGroundPointFromScreen(clientX, clientY, options = {}) {
    if (!this.camera || !this.canvas || !this.raycaster || !this.THREE) return null;
    const rect = this.canvas.getBoundingClientRect();
    const width = Number(rect.width), height = Number(rect.height);
    if (!(width > 0) || !(height > 0)) return null;
    const x = Number(clientX), y = Number(clientY);
    if (![x, y].every(Number.isFinite)) return null;
    this.camera.updateMatrixWorld?.(true);
    const pointer = new this.THREE.Vector2(
      ((x - rect.left) / width) * 2 - 1,
      -((y - rect.top) / height) * 2 + 1,
    );
    this.raycaster.setFromCamera(pointer, this.camera);
    const groundY = Number.isFinite(Number(options?.y))
      ? Number(options.y)
      : GALAXY_SURFACE_Y - 0.18;
    const directionY = this.raycaster.ray.direction.y;
    if (Math.abs(directionY) < 1e-5) return null;
    const distanceAlongRay = (groundY - this.raycaster.ray.origin.y) / directionY;
    if (!(distanceAlongRay > 0) || !Number.isFinite(distanceAlongRay)) return null;
    const hit = this.raycaster.ray.origin.clone().addScaledVector(
      this.raycaster.ray.direction,
      distanceAlongRay,
    );
    return this.getGalaxyGroundPoint(hit.x, hit.z, { ...options, y: groundY });
  }

  /** Set the pet's world anchor and enable star-pushing collision feedback. */
  setPetWorldPosition(worldPosition, options = {}) {
    const position = this._positionVector(worldPosition);
    if (!position) return false;
    const previous = this.petWorldPosition?.clone?.() || position.clone();
    if (!this.petWorldPosition) this.petWorldPosition = position.clone();
    const now = Number(this.elapsed) || 0;
    const elapsed = Math.max(0.001, now - (Number(this.petPositionUpdatedAt) || now - 1 / 60));
    this.petWorldPosition.copy(position);
    this.petWorldVelocity.copy(position).sub(previous).multiplyScalar(1 / elapsed);
    this.petPositionUpdatedAt = now;
    this.petCollisionEnabled = options.enabled !== false;
    if (this.petSprite) this.petSprite.visible = this.petSpriteVisible;
    return true;
  }

  getPetWorldPosition() {
    return this.petWorldPosition ? this._positionObject(this.petWorldPosition) : null;
  }

  clearPetWorldPosition() {
    this.petWorldPosition = null;
    this.petWorldVelocity?.set?.(0, 0, 0);
    this.petCollisionEnabled = false;
    if (this.petSprite) this.petSprite.visible = false;
    return true;
  }

  openBottle() {
    if (this.destroyed) return false;
    if (!this.initialized) {
      this.pendingOpen = true;
      return true;
    }
    if (this.pourState !== "sealed") return false;

    this._prepareReleasePlan({ refreshSeed: true });
    this.pendingOpen = false;
    this.pourState = "uncorking";
    this.openStartedAt = this.elapsed;
    this.releaseCursor = 0;
    this.hoveredIndex = -1;
    this.canvas.style.cursor = "default";

    const worldPosition = new this.THREE.Vector3();
    const worldQuaternion = new this.THREE.Quaternion();
    this.corkGroup.getWorldPosition(worldPosition);
    this.corkGroup.getWorldQuaternion(worldQuaternion);
    this.scene.attach(this.corkGroup);
    this.corkStartPosition = worldPosition.clone();
    this.corkStartQuaternion = worldQuaternion.clone();

    if (this.world) this.world.gravity.set(0, -3.9, 0);
    this.onPourChange({ phase: "uncorking", opened: true, progress: 0 });
    return true;
  }

  _updatePourAnimation() {
    if (this.pourState === "sealed") return;
    const t = this.elapsed - this.openStartedAt;
    const pourStart = 1.62;
    const pourEnd = Math.max(pourStart + 0.8, this.finalReleaseAt + 0.18);
    const approach = smoothstep((t - 0.18) / 0.76);
    const travel = smoothstep((t - pourStart) / (pourEnd - pourStart));
    const tilt = smoothstep((t - 0.7) / (pourStart - 0.7));
    const retirement = smoothstep((t - (this.finalReleaseAt + 1.5)) / 1.18);
    // The bottle profile points toward local +Y. A negative turn puts the
    // mouth down and to the right while the bottle sweeps right-to-left.
    const bottleAngle = -2.5 * tilt;
    const fieldCenterX = this.galaxyCenterX ?? 0.72;
    const travelHalfWidth = Math.min(
      3.8,
      Math.max(2.2, ((this.galaxyHalfWidth || 4.8) - 0.55) * 0.68),
    );
    const leftMouthX = fieldCenterX - travelHalfWidth;
    const rightMouthX = fieldCenterX + travelHalfWidth;
    const mouthX = t < pourStart
      ? rightMouthX * approach
      : rightMouthX - (rightMouthX - leftMouthX) * travel;
    const mouthY =
      BOTTLE_MOUTH_Y + (GALAXY_SURFACE_Y + 0.58 - BOTTLE_MOUTH_Y) * tilt +
      Math.sin(tilt * Math.PI) * 0.18;
    const bottleX = mouthX + BOTTLE_MOUTH_Y * Math.sin(bottleAngle);
    const bottleY = mouthY - BOTTLE_MOUTH_Y * Math.cos(bottleAngle);

    this.bottleGroup.position.set(
      bottleX - 3.2 * retirement,
      bottleY + 1.05 * retirement,
      -1.15 * retirement,
    );
    this.bottleGroup.rotation.z = bottleAngle + 0.12 * retirement;
    if (retirement > 0 && !this.bottleRetired) this._retireBottleColliders();
    if (retirement >= 0.995) this.bottleGroup.visible = false;

    const lift = smoothstep(t / 0.68);
    const fallTime = Math.max(0, t - 0.72);
    this.corkGroup.position.set(
      this.corkStartPosition.x - 0.35 * lift - 0.27 * fallTime,
      this.corkStartPosition.y + Math.sin(lift * Math.PI * 0.72) * 1.28 -
        fallTime * fallTime * 0.78,
      this.corkStartPosition.z + 0.2 * lift,
    );
    this._tmpQuaternion.setFromEuler(
      new this.THREE.Euler(lift * 0.7, lift * 0.25, lift * 1.65 + fallTime * 1.1),
    );
    this.corkGroup.quaternion.copy(this.corkStartQuaternion).multiply(this._tmpQuaternion);
    this.corkGroup.visible = this.corkGroup.position.y > -4;

    if (this.galaxySurface) {
      this.galaxySurface.visible = t >= 1.25;
      this.galaxySurface.material.opacity = 0.13 * smoothstep((t - 1.25) / 1.9);
    }

    if (this.pourState === "uncorking" && t >= 1.22) {
      this.pourState = "pouring";
      this.onPourChange({ phase: "pouring", opened: true, progress: 0.5 });
    }

    if (t >= this.finalReleaseAt + 0.24) {
      for (const record of this.records) {
        if (record.state === "contained") this._activateRecord(record);
      }
    }
    if (t >= this.finalReleaseAt + 1.36) {
      for (const record of this.records) {
        if (record.state === "physics") this._handoffRecord(record);
      }
    }
    if (t >= this.finalReleaseAt + 7.4) {
      for (const record of this.records) {
        if (record.state !== "floating") this._beginFloatingRecord(record);
      }
    }

    const allFrozen =
      this.records.length > 0 && this.records.every((record) => record.state === "floating");
    if (this.pourState !== "settled" && allFrozen && t >= 6.2) {
      this.pourState = "settled";
      this.onPourChange({ phase: "settled", opened: true, progress: 1 });
    }

    const cameraShift = smoothstep((t - 0.45) / 2.3);
    this.cameraTarget.x = fieldCenterX * cameraShift;
    this.cameraTarget.y = -0.1 - 1.38 * cameraShift;
    this.cameraTarget.z = 0.18 * cameraShift;
    this.presentationPitch = 0.035 + 0.5 * smoothstep((t - 0.9) / 2.8);
  }

  _syncBottleColliders() {
    if (!this.world || !this.bottleGroup || this.bottleRetired) return;
    const CANNON = this.CANNON;
    const rotation = new CANNON.Quaternion();
    rotation.setFromEuler(0, 0, this.bottleGroup.rotation.z);
    const basePosition = new CANNON.Vec3(
      this.bottleGroup.position.x,
      this.bottleGroup.position.y,
      this.bottleGroup.position.z,
    );
    const rotatedPosition = new CANNON.Vec3();
    const worldQuaternion = new CANNON.Quaternion();

    for (const collider of this.bottleColliders) {
      rotation.vmult(collider.localPosition, rotatedPosition);
      collider.body.position.set(
        basePosition.x + rotatedPosition.x,
        basePosition.y + rotatedPosition.y,
        basePosition.z + rotatedPosition.z,
      );
      rotation.mult(collider.localQuaternion, worldQuaternion);
      collider.body.quaternion.copy(worldQuaternion);
      collider.body.aabbNeedsUpdate = true;
    }
  }

  _bottleInnerRadiusAt(localY) {
    if (localY <= 0.62) return 1.19;
    if (localY < 1.08) {
      const shoulder = smoothstep((localY - 0.62) / 0.46);
      return 1.19 + (1.02 - 1.19) * shoulder;
    }
    return 0.91;
  }

  _constrainPhysicsRecord(record) {
    const body = record.body;
    if (!body || this.bottleRetired) return;

    const localPosition = this._physicsLocalPosition
      .set(body.position.x, body.position.y, body.position.z)
      .sub(this.bottleGroup.position)
      .applyQuaternion(this._bottleInverseQuaternion);
    if (localPosition.y > BOTTLE_MOUTH_Y + 0.2) return;

    let corrected = false;
    let hitBottom = false;
    const minimumCenterY = -1.985;
    if (localPosition.y < minimumCenterY) {
      localPosition.y = minimumCenterY;
      corrected = true;
      hitBottom = true;
    }

    const radialDistance = Math.hypot(localPosition.x, localPosition.z);
    const allowedRadius = Math.max(
      0.7,
      this._bottleInnerRadiusAt(localPosition.y) - STAR_COLLISION_RADIUS * 1.08,
    );
    let normalX = 0;
    let normalZ = 0;
    if (radialDistance > allowedRadius) {
      normalX = localPosition.x / radialDistance;
      normalZ = localPosition.z / radialDistance;
      localPosition.x = normalX * allowedRadius;
      localPosition.z = normalZ * allowedRadius;
      corrected = true;
    }
    if (!corrected) return;

    this._physicsWorldPosition
      .copy(localPosition)
      .applyQuaternion(this._bottleWorldQuaternion)
      .add(this.bottleGroup.position);
    body.position.set(
      this._physicsWorldPosition.x,
      this._physicsWorldPosition.y,
      this._physicsWorldPosition.z,
    );

    const localVelocity = this._physicsLocalVelocity
      .set(body.velocity.x, body.velocity.y, body.velocity.z)
      .applyQuaternion(this._bottleInverseQuaternion);
    if (normalX || normalZ) {
      const outwardSpeed = localVelocity.x * normalX + localVelocity.z * normalZ;
      if (outwardSpeed > 0) {
        localVelocity.x -= normalX * outwardSpeed * 1.08;
        localVelocity.z -= normalZ * outwardSpeed * 1.08;
      }
    }
    if (hitBottom && localVelocity.y < 0) localVelocity.y *= -0.08;
    this._physicsWorldVelocity
      .copy(localVelocity)
      .applyQuaternion(this._bottleWorldQuaternion);
    body.velocity.set(
      this._physicsWorldVelocity.x,
      this._physicsWorldVelocity.y,
      this._physicsWorldVelocity.z,
    );
    body.aabbNeedsUpdate = true;
    body.wakeUp();
  }

  _retireBottleColliders() {
    if (this.bottleRetired) return;
    this.bottleRetired = true;
    if (!this.world) return;
    for (const collider of this.bottleColliders) {
      if (this.world.bodies.includes(collider.body)) this.world.removeBody(collider.body);
    }
    this.bottleColliders.length = 0;
  }

  _syncContainedStars() {
    if (!this.bottleGroup || !this.records.length) return;
    this.bottleGroup.updateMatrixWorld(true);
    this.bottleGroup.getWorldQuaternion(this._tmpQuaternion2);

    for (const record of this.records) {
      if (record.state !== "contained") continue;
      record.position.copy(record.localPosition).applyMatrix4(this.bottleGroup.matrixWorld);
      record.quaternion.copy(this._tmpQuaternion2).multiply(record.localQuaternion);
      if (record.body) {
        record.body.position.set(record.position.x, record.position.y, record.position.z);
        record.body.quaternion.set(
          record.quaternion.x,
          record.quaternion.y,
          record.quaternion.z,
          record.quaternion.w,
        );
        record.body.velocity.set(0, 0, 0);
        record.body.angularVelocity.set(0, 0, 0);
        record.body.aabbNeedsUpdate = true;
      }
    }
  }

  _activateDueStars() {
    if (this.pourState === "sealed" || this.pourState === "settled") return;
    const t = this.elapsed - this.openStartedAt;
    let activatedThisFrame = 0;
    while (this.releaseCursor < this.releaseQueue.length && activatedThisFrame < 16) {
      const record = this.releaseQueue[this.releaseCursor];
      if (record.releaseAt > t) break;
      this.releaseCursor += 1;
      if (record.state === "contained") {
        this._activateRecord(record);
        activatedThisFrame += 1;
      }
    }
  }

  _getMouthPose() {
    this.bottleGroup.updateMatrixWorld(true);
    const position = this._tmpVector
      .set(0, BOTTLE_MOUTH_Y, 0)
      .applyMatrix4(this.bottleGroup.matrixWorld);
    this.bottleGroup.getWorldQuaternion(this._tmpQuaternion2);
    const outward = this._tmpVector2.set(0, 1, 0).applyQuaternion(this._tmpQuaternion2).normalize();
    return {
      position: position.clone(),
      outward: outward.clone(),
    };
  }

  _activateRecord(record) {
    if (record.state !== "contained") return;
    record.state = "physics";
    record.physicsStartedAt = this.elapsed;

    if (!record.body || !this.world) return;
    const body = record.body;
    const mouth = this._getMouthPose();
    const lane = record.releaseRank % RELEASE_BATCH_SIZE;
    const side = (lane - (RELEASE_BATCH_SIZE - 1) * 0.5) * 0.105;
    const depth = (((record.releaseRank * 7) % 5) - 2) * 0.035;
    const tangentX = -mouth.outward.y;
    const tangentY = mouth.outward.x;
    record.physicsDuration = 0.82 + record.flowBias * 0.16;
    record.mouthPlanePosition = mouth.position.clone();
    record.mouthOutward = mouth.outward.clone();
    const outwardSpeed = 0.72 + record.flowBias * 0.34;
    body.type = this.CANNON.Body.DYNAMIC;
    body.mass = 0.028;
    body.collisionResponse = true;
    body.collisionFilterGroup = 1;
    body.collisionFilterMask = 3;
    body.updateMassProperties();
    body.position.set(
      mouth.position.x - mouth.outward.x * 0.14 + tangentX * side,
      mouth.position.y - mouth.outward.y * 0.14 + tangentY * side,
      mouth.position.z + depth,
    );
    body.velocity.set(
      mouth.outward.x * outwardSpeed,
      mouth.outward.y * outwardSpeed,
      (record.flowBias - 0.5) * 0.22,
    );
    body.angularVelocity.set(
      (record.flowBias - 0.5) * 1.45,
      (0.5 - record.flowBias) * 1.1,
      (record.flowBias - 0.5) * 1.6,
    );
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);
    body.aabbNeedsUpdate = true;
    body.wakeUp();
  }

  _disableBody(record) {
    const body = record.body;
    if (!body) return;
    body.velocity.set(0, 0, 0);
    body.angularVelocity.set(0, 0, 0);
    body.force.set(0, 0, 0);
    body.torque.set(0, 0, 0);
    body.mass = 0;
    body.type = this.CANNON.Body.KINEMATIC;
    body.collisionResponse = false;
    body.collisionFilterMask = 0;
    body.updateMassProperties();
    body.sleep();
  }

  _handoffRecord(record) {
    if (record.state !== "physics") return;
    const THREE = this.THREE;
    if (record.body) {
      record.position.set(
        record.body.position.x,
        record.body.position.y,
        record.body.position.z,
      );
      record.quaternion.set(
        record.body.quaternion.x,
        record.body.quaternion.y,
        record.body.quaternion.z,
        record.body.quaternion.w,
      );
    }

    const mouth = record.mouthPlanePosition && record.mouthOutward
      ? { position: record.mouthPlanePosition, outward: record.mouthOutward }
      : this._getMouthPose();
    const lane = record.releaseRank % RELEASE_BATCH_SIZE;
    const batch = Math.floor(record.releaseRank / RELEASE_BATCH_SIZE);
    const side = (lane - (RELEASE_BATCH_SIZE - 1) * 0.5) * 0.085;
    const depth = (((lane * 5 + batch * 3) % 7) - 3) * 0.024;
    record.state = "exiting";
    record.escaped = true;
    record.flowStart = record.position.clone();
    record.flowStartQuaternion = record.quaternion.clone();
    const mouthProjection = record.flowStart.clone().sub(mouth.position).dot(mouth.outward);
    record.mouthPass = mouthProjection >= 0
      ? record.flowStart.clone().addScaledVector(mouth.outward, 0.1)
      : mouth.position
        .clone()
        .addScaledVector(mouth.outward, 0.05)
        .add(new THREE.Vector3(-mouth.outward.y * side, mouth.outward.x * side, depth));
    record.exitPosition = mouth.position
      .clone()
      .addScaledVector(mouth.outward, 0.38 + record.flowBias * 0.16)
      .add(new THREE.Vector3(-mouth.outward.y * side, mouth.outward.x * side, depth * 1.35));
    const landingDistance = record.exitPosition.distanceTo(record.targetPosition);
    record.galaxyDuration = 1.5 + Math.min(5.2, landingDistance * 0.72);
    record.exitStartedAt = this.elapsed;
    record.exitDuration = 0.48 + record.flowBias * 0.12;
    this._disableBody(record);
  }

  _beginFloatingRecord(record) {
    if (record.state === "floating") return;
    record.state = "floating";
    record.frozen = false;
    record.escaped = true;
    record.position.copy(record.targetPosition);
    record.quaternion.copy(record.targetQuaternion);
    record.floatVelocity.set(0, 0, 0);
    this._disableBody(record);
    if (record.body) {
      record.body.position.set(
        record.targetPosition.x,
        record.targetPosition.y,
        record.targetPosition.z,
      );
      record.body.quaternion.set(
        record.targetQuaternion.x,
        record.targetQuaternion.y,
        record.targetQuaternion.z,
        record.targetQuaternion.w,
      );
      record.body.aabbNeedsUpdate = true;
    }
  }

  _updateStarMotion() {
    const constrainToBottle =
      this.world && !this.bottleRetired && this.pourState !== "sealed";
    if (constrainToBottle) {
      this.bottleGroup.updateMatrixWorld(true);
      this.bottleGroup.getWorldQuaternion(this._bottleWorldQuaternion);
      this._bottleInverseQuaternion.copy(this._bottleWorldQuaternion).invert();
    }

    for (const record of this.records) {
      if (record.state === "physics") {
        if (constrainToBottle) this._constrainPhysicsRecord(record);
        if (record.body) {
          const velocity = record.body.velocity;
          const speedSquared =
            velocity.x * velocity.x + velocity.y * velocity.y + velocity.z * velocity.z;
          if (speedSquared > 18) {
            const scale = Math.sqrt(18 / speedSquared);
            velocity.scale(scale, velocity);
          }
        }
        const activeTime = this.elapsed - record.physicsStartedAt;
        const body = record.body;
        const crossedMouth = body && record.mouthPlanePosition && record.mouthOutward
          ? (body.position.x - record.mouthPlanePosition.x) * record.mouthOutward.x +
              (body.position.y - record.mouthPlanePosition.y) * record.mouthOutward.y +
              (body.position.z - record.mouthPlanePosition.z) * record.mouthOutward.z >= 0.27
          : false;
        if ((crossedMouth && activeTime >= 0.12) || activeTime >= record.physicsDuration) {
          this._handoffRecord(record);
        }
        continue;
      }

      if (record.state === "exiting") {
        const progress = clamp(
          (this.elapsed - record.exitStartedAt) / record.exitDuration,
          0,
          1,
        );
        if (progress < 0.62) {
          const firstProgress = smoothstep(progress / 0.62);
          record.position.lerpVectors(record.flowStart, record.mouthPass, firstProgress);
        } else {
          const secondProgress = smoothstep((progress - 0.62) / 0.38);
          record.position.lerpVectors(record.mouthPass, record.exitPosition, secondProgress);
        }
        record.quaternion
          .copy(record.flowStartQuaternion)
          .slerp(record.targetQuaternion, progress * 0.42);
        if (progress >= 1) {
          record.state = "galaxy";
          record.galaxyStart = record.exitPosition.clone();
          record.galaxyStartQuaternion = record.quaternion.clone();
          record.galaxyStartedAt = this.elapsed;
        }
        continue;
      }

      if (record.state === "galaxy") {
        const progress = clamp(
          (this.elapsed - record.galaxyStartedAt) / record.galaxyDuration,
          0,
          1,
        );
        const eased = smoothstep(progress);
        record.position.lerpVectors(record.galaxyStart, record.targetPosition, eased);
        record.position.y += Math.sin(progress * Math.PI) * (0.04 + record.flowBias * 0.035);
        record.quaternion
          .copy(record.galaxyStartQuaternion)
          .slerp(record.targetQuaternion, eased);
        if (progress >= 1) this._beginFloatingRecord(record);
      }
    }
  }

  _waveHeightAt(x, z, time) {
    const centerX = this.galaxyCenterX || 0;
    const centerZ = this.galaxyCenterZ || 0;
    const radialDistance = Math.hypot(x - centerX + 1.15, z - centerZ - 0.3);
    return (
      Math.sin(x * 1.18 + z * 0.44 - time * 1.42) * 0.055 +
      Math.sin(z * 1.72 - x * 0.24 + time * 1.06) * 0.034 +
      Math.sin(radialDistance * 2.18 - time * 1.68) * 0.024
    );
  }

  _updateFloatingMotion(delta) {
    const floating = this.records.filter((record) => record.state === "floating");
    if (!floating.length) return;

    const step = clamp(delta, 0.001, 0.045);
    const damping = Math.exp(-4.1 * step);
    const pointer = this.pointerWorld;
    const interactionPointer =
      this.isDragging && this.dragMode === "star" ? pointer : null;
    const pointerRadiusSquared = FLOAT_POINTER_RADIUS * FLOAT_POINTER_RADIUS;
    const pet = this.petCollisionEnabled ? this.petWorldPosition : null;
    const petInfluenceRadius = this.petCollisionRadius + FLOAT_COLLISION_DISTANCE + 0.22;
    const petInfluenceRadiusSquared = petInfluenceRadius * petInfluenceRadius;
    const petSpeed = pet ? Math.hypot(this.petWorldVelocity?.x || 0, this.petWorldVelocity?.z || 0) : 0;

    for (const record of floating) {
      const phase = record.floatPhase + this.elapsed * record.floatFrequency;
      const draggingThisStar =
        this.isDragging &&
        this.dragMode === "star" &&
        record.index === this.draggedStarIndex &&
        pointer;
      if (draggingThisStar) {
        record.position.set(pointer.x, record.targetPosition.y + 0.11, pointer.z);
        record.floatVelocity.set(0, 0, 0);
        this._floatEuler.set(0.04, Math.sin(phase) * 0.08, -0.05);
        this._floatQuaternion.setFromEuler(this._floatEuler);
        record.quaternion.copy(record.targetQuaternion).multiply(this._floatQuaternion);
        continue;
      }

      if (record.frozen && record.index === this.hoveredIndex) {
        record.floatVelocity.set(0, 0, 0);
        continue;
      }

      const desiredX = record.targetPosition.x;
      const desiredZ = record.targetPosition.z;
      const desiredY =
        record.targetPosition.y + this._waveHeightAt(desiredX, desiredZ, this.elapsed);
      const returnDistance = Math.hypot(
        desiredX - record.position.x,
        desiredZ - record.position.z,
      );
      const springStrength = 3.65 + Math.min(2.35, returnDistance * 0.78);
      const springX = (desiredX - record.position.x) * springStrength;
      const springZ = (desiredZ - record.position.z) * springStrength;
      record.floatVelocity.x += springX * step;
      record.floatVelocity.z += springZ * step;

      if (interactionPointer) {
        const dx = record.position.x - interactionPointer.x;
        const dz = record.position.z - interactionPointer.z;
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared < pointerRadiusSquared) {
          const distance = Math.sqrt(distanceSquared) || 0.001;
          const influence = 1 - distance / FLOAT_POINTER_RADIUS;
          const strength = (influence * 1.5 + influence * influence * 4.4);
          record.floatVelocity.x += (dx / distance) * strength * step;
          record.floatVelocity.z += (dz / distance) * strength * step;
          const swirl = Math.sin(phase + distance * 5.2) * influence * 0.42;
          record.floatVelocity.x += (-dz / distance) * swirl * step;
          record.floatVelocity.z += (dx / distance) * swirl * step;
        }
      }

      // The pet is a 2D sprite, but its anchor participates in the same
      // horizontal collision field as a star.  A moving pet transfers a
      // little more impulse; a stationary overlap is still separated gently
      // so the character never becomes buried inside a star.
      if (pet && !draggingThisStar) {
        const dx = record.position.x - pet.x;
        const dz = record.position.z - pet.z;
        const distanceSquared = dx * dx + dz * dz;
        if (distanceSquared < petInfluenceRadiusSquared) {
          const distance = Math.sqrt(distanceSquared) || 0.001;
          const normalX = dx / distance;
          const normalZ = dz / distance;
          const influence = 1 - distance / petInfluenceRadius;
          const impulse = (influence * 1.9 + influence * influence * 3.8) * step;
          record.floatVelocity.x += normalX * impulse;
          record.floatVelocity.z += normalZ * impulse;
          if (petSpeed > 0.02) {
            record.floatVelocity.x += (this.petWorldVelocity.x || 0) * influence * 0.18 * step;
            record.floatVelocity.z += (this.petWorldVelocity.z || 0) * influence * 0.18 * step;
          }
          const overlap = this.petCollisionRadius + STAR_COLLISION_RADIUS - distance;
          if (overlap > 0) {
            record.position.x += normalX * overlap * 0.72;
            record.position.z += normalZ * overlap * 0.72;
          }
        }
      }

      record.floatVelocity.multiplyScalar(damping);
      if (returnDistance < 0.018 && !interactionPointer) {
        record.floatVelocity.multiplyScalar(Math.exp(-5.5 * step));
      }
      const horizontalSpeed = Math.hypot(record.floatVelocity.x, record.floatVelocity.z);
      const speedLimit = Math.min(
        FLOAT_RETURN_MAX_SPEED,
        0.42 + returnDistance * 0.62,
      );
      if (horizontalSpeed > speedLimit) {
        const speedScale = speedLimit / horizontalSpeed;
        record.floatVelocity.x *= speedScale;
        record.floatVelocity.z *= speedScale;
      }
      record.position.x += record.floatVelocity.x * step;
      record.position.z += record.floatVelocity.z * step;
      record.position.y += (desiredY - record.position.y) * Math.min(1, step * 5.6);

      const slopeSample = 0.065;
      const slopeX =
        (this._waveHeightAt(desiredX + slopeSample, desiredZ, this.elapsed) -
          this._waveHeightAt(desiredX - slopeSample, desiredZ, this.elapsed)) /
        (slopeSample * 2);
      const slopeZ =
        (this._waveHeightAt(desiredX, desiredZ + slopeSample, this.elapsed) -
          this._waveHeightAt(desiredX, desiredZ - slopeSample, this.elapsed)) /
        (slopeSample * 2);
      this._waveNormal.set(-slopeX, 1, -slopeZ).normalize();
      this._floatQuaternion.setFromUnitVectors(this._worldUp, this._waveNormal);
      record.quaternion.copy(this._floatQuaternion).multiply(record.targetQuaternion);
    }

    // Resolve the floating field on the water plane. The blue-noise targets
    // already have clearance; these passes preserve it during dragging.
    const minimumDistance = FLOAT_COLLISION_DISTANCE;
    const minimumDistanceSquared = minimumDistance * minimumDistance;
    const influenceDistance = FLOAT_NEIGHBOR_INFLUENCE_DISTANCE;
    const influenceDistanceSquared = influenceDistance * influenceDistance;
    for (let iteration = 0; iteration < 4; iteration += 1) {
      for (let first = 0; first < floating.length; first += 1) {
        const left = floating[first];
        for (let second = first + 1; second < floating.length; second += 1) {
          const right = floating[second];
          let dx = right.position.x - left.position.x;
          let dz = right.position.z - left.position.z;
          let distanceSquared = dx * dx + dz * dz;
          if (distanceSquared < 0.000001) {
            const angle = (left.index * 0.61803398875 + right.index * 0.41421356237) * Math.PI;
            dx = Math.cos(angle) * 0.001;
            dz = Math.sin(angle) * 0.001;
            distanceSquared = dx * dx + dz * dz;
          }
          const distance = Math.sqrt(distanceSquared);
          const normalX = dx / distance;
          const normalZ = dz / distance;
          const overlap = minimumDistance - distance;
          const leftDragged = this.isDragging && left.index === this.draggedStarIndex;
          const rightDragged = this.isDragging && right.index === this.draggedStarIndex;
          const leftPinned = leftDragged || (left.frozen && left.index === this.hoveredIndex);
          const rightPinned = rightDragged || (right.frozen && right.index === this.hoveredIndex);
          const relativeVelocity =
            (right.floatVelocity.x - left.floatVelocity.x) * normalX +
            (right.floatVelocity.z - left.floatVelocity.z) * normalZ;

          if (iteration === 0 && distanceSquared < influenceDistanceSquared) {
            const leftSpeed = Math.hypot(left.floatVelocity.x, left.floatVelocity.z);
            const rightSpeed = Math.hypot(right.floatVelocity.x, right.floatVelocity.z);
            const wakeSpeed = Math.max(leftSpeed, rightSpeed);
            if (wakeSpeed > FLOAT_NEIGHBOR_WAKE_MIN_SPEED || relativeVelocity < -0.01) {
              const influence = smoothstep(1 - distance / influenceDistance);
              const wakeImpulse =
                (Math.max(0, -relativeVelocity) * 0.38 + wakeSpeed * 0.075) * influence;
              if (!leftPinned) {
                left.floatVelocity.x -= normalX * wakeImpulse;
                left.floatVelocity.z -= normalZ * wakeImpulse;
              }
              if (!rightPinned) {
                right.floatVelocity.x += normalX * wakeImpulse;
                right.floatVelocity.z += normalZ * wakeImpulse;
              }

              const transfer = influence * 0.055;
              const transferX = (left.floatVelocity.x - right.floatVelocity.x) * transfer;
              const transferZ = (left.floatVelocity.z - right.floatVelocity.z) * transfer;
              if (!leftPinned) {
                left.floatVelocity.x -= transferX;
                left.floatVelocity.z -= transferZ;
              }
              if (!rightPinned) {
                right.floatVelocity.x += transferX;
                right.floatVelocity.z += transferZ;
              }
            }
          }

          if (distanceSquared >= minimumDistanceSquared) continue;

          if (leftPinned && rightPinned) {
            continue;
          } else if (leftPinned) {
            right.position.x += normalX * overlap;
            right.position.z += normalZ * overlap;
          } else if (rightPinned) {
            left.position.x -= normalX * overlap;
            left.position.z -= normalZ * overlap;
          } else {
            const correction = overlap * 0.51;
            left.position.x -= normalX * correction;
            left.position.z -= normalZ * correction;
            right.position.x += normalX * correction;
            right.position.z += normalZ * correction;
          }

          if (relativeVelocity < 0) {
            const impulse = relativeVelocity * 0.36;
            if (!leftPinned) {
              left.floatVelocity.x += normalX * impulse;
              left.floatVelocity.z += normalZ * impulse;
            }
            if (!rightPinned) {
              right.floatVelocity.x -= normalX * impulse;
              right.floatVelocity.z -= normalZ * impulse;
            }
          }
        }
      }
    }
  }

  _updateStarMatrices() {
    if (!this.starMesh) return;
    const dummy = this.instanceDummy;
    const statusMarker = this.statusMarkerDummy;
    if (this.selectionHalo) this.selectionHalo.visible = false;
    if (this.selectionRing) this.selectionRing.visible = false;
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index];
      if (record.state === "physics" && record.body) {
        dummy.position.set(record.body.position.x, record.body.position.y, record.body.position.z);
        dummy.quaternion.set(
          record.body.quaternion.x,
          record.body.quaternion.y,
          record.body.quaternion.z,
          record.body.quaternion.w,
        );
      } else {
        const displayPosition = this._displayPositionForRecord(record);
        if (displayPosition) dummy.position.copy(displayPosition);
        else dummy.position.copy(record.position);
        dummy.quaternion.copy(record.quaternion);
      }

      const filteredOut = this.emotionFilter && record.emotion !== this.emotionFilter;
      let scale = STAR_SCALE;
      if (filteredOut) scale *= 0.34;
      if (index === this.hoveredIndex) scale *= 1.04;
      if (index === this.selectedIndex) {
        scale *= 1.08;
        dummy.position.y += 0.075;
      }
      dummy.scale.setScalar(scale);
      dummy.updateMatrix();
      this.starMesh.setMatrixAt(index, dummy.matrix);

      statusMarker.position.copy(dummy.position);
      if (record.note.changeStatus === "unread") {
        const visualScale = scale / STAR_SCALE;
        const markerOffset = 0.105 * Math.max(0.48, visualScale);
        const pulse = 0.9 + Math.sin(this.elapsed * 2.8 + index * 0.71) * 0.12;
        statusMarker.position.x += markerOffset;
        statusMarker.position.y += markerOffset * 0.92;
        statusMarker.position.z += 0.055;
        statusMarker.rotation.set(
          this.elapsed * 0.7 + index * 0.11,
          this.elapsed * 1.15 + index * 0.23,
          this.elapsed * 0.42,
        );
        statusMarker.scale.setScalar(pulse * (filteredOut ? 0.42 : 1));
      } else {
        statusMarker.quaternion.identity();
        statusMarker.scale.setScalar(0);
      }
      statusMarker.updateMatrix();
      this.statusMarkerMesh.setMatrixAt(index, statusMarker.matrix);

      if (index === this.selectedIndex && this._isStarPickable(index)) {
        const pulse = 1 + Math.sin(this.elapsed * 3.1) * 0.035;
        this.selectionHalo.position.copy(dummy.position);
        this.selectionHalo.quaternion.copy(dummy.quaternion);
        this.selectionHalo.scale.setScalar(STAR_SCALE * 1.3 * pulse);
        this.selectionHalo.visible = true;
        this.selectionHalo.material.opacity = 0.78 + Math.sin(this.elapsed * 3.1) * 0.12;

        this.selectionRing.position.copy(dummy.position);
        this.selectionRing.position.y -= 0.035;
        this.selectionRing.quaternion.copy(dummy.quaternion);
        this.selectionRing.scale.setScalar(STAR_SCALE * (1.18 + (pulse - 1) * 1.7));
        this.selectionRing.visible = true;
      }
    }
    this.starMesh.instanceMatrix.needsUpdate = true;
    this.statusMarkerMesh.instanceMatrix.needsUpdate = true;
  }

  _selectIndex(index, source = "programmatic") {
    if (!Number.isInteger(index) || !this.records[index]) return false;
    this.selectedIndex = index;
    this.selectionStartedAt = this.elapsed;
    this._refreshStarColors();
    const record = this.records[index];
    const screen = this._screenPositionForIndex(index);
    const customColor = String(record.note.color || "").trim();
    this.onSelect(record.note, {
      index,
      source,
      emotion: record.emotion,
      color: /^#[0-9a-f]{6}$/i.test(customColor)
        ? customColor
        : "#" + EMOTION_STYLES[record.emotion].color.toString(16).padStart(6, "0"),
      screen,
    });
    return true;
  }

  focusStar(noteId, options = {}) {
    if (this.destroyed) return Promise.resolve(false);
    if (!this.initialized) return this.ready.then(() => this.focusStar(noteId, options));
    const index = this.noteIndex.get(String(noteId));
    if (!Number.isInteger(index)) return Promise.resolve(false);

    const wasSealed = this.pourState === "sealed";
    if (wasSealed) this.openBottle();
    const record = this.records[index];
    if (record.state === "contained" && this.pourState !== "sealed") {
      record.releaseAt = Math.min(
        record.releaseAt,
        Math.max(1.05, this.elapsed - this.openStartedAt + 0.04),
      );
    }
    this.selectedIndex = index;
    this.selectionStartedAt = this.elapsed;
    this._refreshStarColors();

    clearTimeout(this.focusTimer);
    this.focusResolve?.(false);
    return new Promise((resolve) => {
      this.focusResolve = resolve;
      this.focusTimer = setTimeout(() => {
        if (!this.destroyed && options.notify !== false) this._selectIndex(index, "favorite");
        this.focusResolve = null;
        resolve(!this.destroyed);
      }, wasSealed ? 2500 : 620);
    });
  }

  clearSelection() {
    this.selectedIndex = -1;
    if (this.initialized) this._refreshStarColors();
  }

  _worldPositionForIndex(index) {
    const record = this.records[index];
    if (!record) return null;
    return this._displayPositionForRecord(record)?.clone() || null;
  }

  _screenPositionForIndex(index) {
    const position = this._worldPositionForIndex(index);
    return this.getWorldScreenPosition(position);
  }

  /**
   * Project a world-space point onto the canvas without exposing Three.js
   * objects to the pet controller.  The returned scale is relative to the
   * current camera distance, so a DOM sprite can preserve the board's depth
   * cue while remaining independent from the WebGL scene graph.
   */
  getWorldScreenPosition(worldPosition) {
    if (!worldPosition || !this.camera || !this.canvas || !this.THREE) return null;
    const x = Number(worldPosition.x);
    const y = Number(worldPosition.y);
    const z = Number(worldPosition.z);
    if (![x, y, z].every(Number.isFinite)) return null;
    this.camera.updateMatrixWorld?.(true);
    const projected = new this.THREE.Vector3(x, y, z);
    const cameraSpace = projected.clone().applyMatrix4(this.camera.matrixWorldInverse);
    projected.project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    const distance = Math.max(0.1, -cameraSpace.z);
    const referenceDistance = Math.max(
      0.1,
      Number(this.cameraDistance) || Number(this.baseCameraDistance) || 9.7,
    );
    return {
      x: rect.left + (projected.x * 0.5 + 0.5) * rect.width,
      y: rect.top + (-projected.y * 0.5 + 0.5) * rect.height,
      visible: projected.z > -1 && projected.z < 1,
      depth: distance,
      scale: clamp(referenceDistance / distance, 0.76, 1.18),
      world: { x, y, z },
    };
  }

  /** Return the usable world-space rectangle of the visible galaxy board. */
  getGalaxyGroundBounds(options = {}) {
    options = options && typeof options === "object" ? options : {};
    const centerX = Number(this.galaxyCenterX) || 0.8;
    const centerZ = Number(this.galaxyCenterZ) || 0;
    const halfWidth = Math.max(1, Number(this.galaxyHalfWidth) || 4.8);
    const halfDepth = Math.max(1, Number(this.galaxyHalfDepth) || 2.8);
    const requestedInset = Number(options.inset);
    const inset = Math.max(
      0,
      Number.isFinite(requestedInset) ? requestedInset : 0.18,
    );
    const minX = centerX - Math.max(0.45, halfWidth - inset);
    const maxX = centerX + Math.max(0.45, halfWidth - inset);
    const minZ = centerZ - Math.max(0.45, halfDepth - inset);
    const maxZ = centerZ + Math.max(0.45, halfDepth - inset);
    return {
      minX,
      maxX,
      minZ,
      maxZ,
      centerX,
      centerZ,
      width: Math.max(0.9, maxX - minX),
      depth: Math.max(0.9, maxZ - minZ),
      surfaceY: GALAXY_SURFACE_Y,
      boardY: GALAXY_SURFACE_Y - 0.18,
    };
  }

  /** Resolve a point on the same gently undulating surface used by stars. */
  getGalaxyGroundPoint(x, z, options = {}) {
    options = options && typeof options === "object" ? options : {};
    const bounds = this.getGalaxyGroundBounds(options);
    const numericX = Number(x);
    const numericZ = Number(z);
    const requestedX = Number.isFinite(numericX) ? numericX : bounds.centerX;
    const requestedZ = Number.isFinite(numericZ) ? numericZ : bounds.centerZ;
    // Normal scene callers stay on the board by default.  Pet drag/recovery
    // paths can explicitly opt out so a character may be pulled beyond the
    // galaxy and then walk back through the same world-space plane.
    const clampToBounds = options.clamp !== false;
    const pointX = clampToBounds
      ? clamp(requestedX, bounds.minX, bounds.maxX)
      : requestedX;
    const pointZ = clampToBounds
      ? clamp(requestedZ, bounds.minZ, bounds.maxZ)
      : requestedZ;
    const baseY = Number(options.y);
    const y = Number.isFinite(baseY)
      ? baseY
      : GALAXY_SURFACE_Y - 0.18 + this._waveHeightAt(pointX, pointZ, this.elapsed) * 0.15;
    return { x: pointX, y, z: pointZ };
  }

  _recordForNoteId(noteId) {
    const index = this.noteIndex.get(String(noteId));
    return Number.isInteger(index) ? this.records[index] || null : null;
  }

  getStarSnapshot(noteId) {
    const record = this._recordForNoteId(noteId);
    if (!record) return null;
    const position = this._worldPositionForIndex(record.index);
    const targetPosition = record.targetPosition?.clone?.() || null;
    return {
      noteId: String(record.note.id),
      index: record.index,
      state: record.state,
      emotion: record.emotion,
      position: this._positionObject(position),
      targetPosition: this._positionObject(targetPosition),
      screenPosition: this._screenPositionForIndex(record.index),
      distanceFromTarget: position && targetPosition
        ? position.distanceTo(targetPosition)
        : null,
    };
  }

  getStarScreenPosition(noteId) {
    const record = this._recordForNoteId(noteId);
    return record ? this._screenPositionForIndex(record.index) : null;
  }

  getFloatingStarSnapshots() {
    return this.records
      .filter((record) => record.state === "floating")
      .map((record) => {
        const position = this._worldPositionForIndex(record.index);
        return {
          noteId: String(record.note.id),
          index: record.index,
          state: record.state,
          emotion: record.emotion,
          position: this._positionObject(position),
          targetPosition: this._positionObject(record.targetPosition),
          screenPosition: this.getWorldScreenPosition(position),
        };
      });
  }

  getClusterCenter() {
    if (!this.records.length) {
      return { x: 0, y: GALAXY_SURFACE_Y, z: 0 };
    }
    const positions = this.records
      .filter((record) => record.state === "floating" && record.targetPosition)
      .map((record) => record.targetPosition);
    if (!positions.length) {
      return {
        x: Number(this.galaxyCenterX) || 0,
        y: GALAXY_SURFACE_Y,
        z: Number(this.galaxyCenterZ) || 0,
      };
    }
    const center = positions.reduce(
      (result, position) => result.add(position),
      new this.THREE.Vector3(),
    ).multiplyScalar(1 / positions.length);
    return this._positionObject(center);
  }

  claimStarVisual(noteId) {
    const record = this._recordForNoteId(noteId);
    if (!record || record.state !== "floating") return false;
    const id = String(record.note.id);
    const existing = this.visualClaims.get(id);
    if (existing?.index === record.index) return true;
    const position = this._displayPositionForRecord(record);
    if (!position) return false;
    this.visualClaims.set(id, {
      index: record.index,
      position: position.clone(),
    });
    return true;
  }

  setStarVisualPosition(noteId, worldPosition) {
    const id = String(noteId);
    const record = this._recordForNoteId(id);
    const claim = this.visualClaims.get(id);
    const position = this._positionVector(worldPosition);
    if (!record || record.state !== "floating" || !claim || !position) return false;
    if (claim.index !== record.index) return false;
    claim.position.copy(position);
    return true;
  }

  /**
   * Apply a small transient impulse to a floating star.  This is intentionally
   * velocity-first: targetPosition, shared geometry, and Cannon bodies remain
   * untouched, so the normal floating spring/collision pass owns recovery.
   * A tiny visual nudge makes a close contact readable even between frames.
   * DOM pets use this when their world-space walk path brushes a star.
   */
  pushStarVisual(noteId, impulse = {}) {
    const id = String(noteId);
    const record = this._recordForNoteId(id);
    if (!record || record.state !== "floating" || !record.floatVelocity) return false;
    const x = Number(impulse?.x);
    const z = Number(impulse?.z);
    if (![x, z].every(Number.isFinite)) return false;
    const maxImpulse = Math.max(0.02, Number(impulse?.max) || 0.42);
    const magnitude = Math.hypot(x, z);
    const scale = magnitude > maxImpulse ? maxImpulse / magnitude : 1;
    const appliedX = x * scale;
    const appliedZ = z * scale;
    record.floatVelocity.x += appliedX;
    record.floatVelocity.z += appliedZ;
    const claim = this.visualClaims.get(id);
    const position = claim?.index === record.index ? claim.position : record.position;
    if (position) {
      position.x += appliedX * 0.045;
      position.z += appliedZ * 0.045;
      if (claim?.index === record.index) claim.position.copy(position);
    }
    return true;
  }

  releaseStarVisual(noteId, options = {}) {
    const id = String(noteId);
    const record = this._recordForNoteId(id);
    const claim = this.visualClaims.get(id);
    if (!record || !claim || claim.index !== record.index) return false;
    const snapToTarget = options?.snapToTarget !== false;
    if (record.state === "floating") {
      const releasePosition = snapToTarget ? record.targetPosition : claim.position;
      if (releasePosition) record.position.copy(releasePosition);
      record.floatVelocity.set(0, 0, 0);
    }
    this.visualClaims.delete(id);
    return true;
  }

  _normalizeHeartPositions(positions) {
    const normalized = new Map();
    if (!positions) return normalized;
    const entries = positions instanceof Map
      ? [...positions.entries()]
      : Array.isArray(positions)
        ? positions.map((position, index) => [index, position])
        : typeof positions === "object"
          ? Object.entries(positions)
          : [];
    for (const [key, candidate] of entries) {
      const numericKey = Number(key);
      const index = Number.isInteger(numericKey) && numericKey >= 0
        ? numericKey
        : this.noteIndex.get(String(key));
      if (!Number.isInteger(index)) continue;
      const record = this.records[index];
      if (!record || record.state !== "floating") continue;
      const x = Number(Array.isArray(candidate) ? candidate[0] : candidate?.x);
      const z = Number(Array.isArray(candidate) ? candidate[2] ?? candidate[1] : candidate?.z);
      const explicitY = Number(Array.isArray(candidate) ? candidate[2] === undefined ? undefined : candidate[1] : candidate?.y);
      const y = Number.isFinite(explicitY)
        ? explicitY
        : Number(record.targetPosition?.y ?? GALAXY_SURFACE_Y);
      const vector = [x, y, z].every(Number.isFinite)
        ? new this.THREE.Vector3(x, y, z)
        : null;
      if (vector) normalized.set(index, vector);
    }
    return normalized;
  }

  setHeartArrayOverride(progress, positions) {
    const normalized = this._normalizeHeartPositions(positions);
    if (!normalized.size) return false;
    const amount = clamp(Number(progress) || 0, 0, 1);
    if (!this.heartArrayOverride) {
      this.heartArrayOverride = {
        progress: 0,
        bases: new Map(),
        positions: new Map(),
      };
    }
    const override = this.heartArrayOverride;
    override.progress = amount;
    for (const [index, target] of normalized) {
      if (!override.bases.has(index)) {
        const record = this.records[index];
        const base = this._baseWorldPositionForRecord(record)?.clone?.() || null;
        if (base) override.bases.set(index, base);
      }
      const base = override.bases.get(index);
      if (!base) continue;
      const visual = override.positions.get(index) || new this.THREE.Vector3();
      visual.lerpVectors(base, target, amount);
      override.positions.set(index, visual);
    }
    return true;
  }

  clearHeartArrayOverride() {
    const hadOverride = Boolean(this.heartArrayOverride);
    this.heartArrayOverride = null;
    return hadOverride;
  }

  getEmotionAnchors() {
    const anchors = {};
    for (const emotion of EMOTION_KEYS) {
      const index = this.anchorIndices[emotion];
      if (Number.isInteger(index)) anchors[emotion] = this._screenPositionForIndex(index);
    }
    return anchors;
  }

  getDebugState(includePositions = false) {
    const states = {
      contained: 0,
      physics: 0,
      exiting: 0,
      galaxy: 0,
      floating: 0,
    };
    for (const record of this.records) states[record.state] += 1;
    const bottleCount = states.contained + states.physics;
    const result = {
      total: this.records.length,
      rendered: this.starMesh?.count || 0,
      phase: this.pourState,
      pourState: this.pourState,
      frozen: 0,
      floating: states.floating,
      inside: bottleCount,
      bottleCount,
      bottleEmpty: bottleCount === 0,
      escaped: states.exiting + states.galaxy + states.floating,
      dynamic: states.physics,
      layoutSeed: this.layoutSeed,
      states,
    };
    if (includePositions) {
      result.positions = this.records.map((record) => {
        const position = this._worldPositionForIndex(record.index);
        return {
          id: String(record.note.id),
          state: record.state,
          x: position.x,
          y: position.y,
          z: position.z,
        };
      });
    }
    return result;
  }

  _installDebugSurface() {
    this.debugSurface = {
      scene: this,
      getState: (includePositions = false) => this.getDebugState(includePositions),
      openBottle: () => this.openBottle(),
    };
    globalThis.__STAR_BOTTLE_SCENE__ = this;
    globalThis.__STAR_BOTTLE_DEBUG__ = this.debugSurface;
  }

  resize() {
    if (this.destroyed || !this.initialized) return;
    const width = Math.max(
      1,
      this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || globalThis.innerWidth,
    );
    const height = Math.max(
      1,
      this.canvas.clientHeight || this.canvas.parentElement?.clientHeight || globalThis.innerHeight,
    );
    const aspect = width / height;
    this.camera.aspect = aspect;
    this.camera.fov = aspect < 0.72 ? 53 : aspect < 1.1 ? 47 : 42;
    this.baseCameraDistance = aspect < 0.72 ? 13.1 : aspect < 1.1 ? 11.2 : 9.7;
    if (!this.layoutWidth || !Number.isFinite(this.cameraDistance)) {
      this.cameraDistance = this.baseCameraDistance;
    }
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 1.7));
    this.renderer.setSize(width, height, false);
    if (width !== this.layoutWidth || height !== this.layoutHeight) {
      this.layoutWidth = width;
      this.layoutHeight = height;
      this._relayoutGalaxyTargets();
    }
  }

  _updateCamera(delta) {
    const baseDistance = this.baseCameraDistance || 9.7;
    const halfFov = (this.camera.fov * Math.PI) / 360;
    const widthDistance = this.galaxyHalfWidth
      ? this.galaxyHalfWidth /
        Math.max(0.2, Math.tan(halfFov) * Math.max(0.55, this.camera.aspect))
      : 0;
    const depthAllowance = (this.galaxyHalfDepth || 0) * 0.86;
    const openDistance = Math.max(
      baseDistance + 2.15,
      (widthDistance + depthAllowance) * 1.06,
    );
    const targetDistance = this.pourState === "sealed" ? baseDistance : openDistance;
    this.cameraDistance +=
      (targetDistance - this.cameraDistance) * Math.min(1, delta * 3.2);
    const minimumPitch = this.pourState === "sealed" ? -0.05 : 0.24;
    const effectivePitch = clamp(
      this.presentationPitch + this.viewPitch,
      minimumPitch,
      0.79,
    );
    const cosPitch = Math.cos(effectivePitch);
    this.cameraDesiredPosition.set(
      this.cameraTarget.x + Math.sin(this.viewYaw) * cosPitch * this.cameraDistance,
      this.cameraTarget.y + Math.sin(effectivePitch) * this.cameraDistance,
      this.cameraTarget.z + Math.cos(this.viewYaw) * cosPitch * this.cameraDistance,
    );
    this.camera.position.lerp(this.cameraDesiredPosition, Math.min(1, delta * 6.5));
    this.camera.lookAt(this.cameraTarget);
  }

  _frame(now) {
    if (this.destroyed) return;
    const delta = Math.min(0.045, Math.max(0.001, (now - this.lastFrame) / 1000));
    this.lastFrame = now;
    this.elapsed += delta;

    this._updatePourAnimation();
    this._updateCamera(delta);
    this._syncBottleColliders();
    this._syncContainedStars();
    this._activateDueStars();
    if (this.world) this.world.step(1 / 90, delta, 5);
    this._updateStarMotion();
    this._updatePointerWorld();
    this._updateHover();
    this._updateFloatingMotion(delta);
    this._updatePetSprite();

    this.skyNear.rotation.y += delta * 0.0022;
    this.skyFar.rotation.y -= delta * 0.001;
    this.skyNear.material.opacity = 0.68 + Math.sin(this.elapsed * 0.52) * 0.035;

    this._updateStarMatrices();

    if (this.onEmotionAnchors && this.elapsed - this.lastAnchorEmit >= 0.12) {
      this.lastAnchorEmit = this.elapsed;
      this.onEmotionAnchors(this.getEmotionAnchors(), this.pourState);
    }

    this.renderer.render(this.scene, this.camera);
    this.animationFrame = requestAnimationFrame(this._frame);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.visualClaims.clear();
    this.heartArrayOverride = null;
    cancelAnimationFrame(this.animationFrame);
    clearTimeout(this.focusTimer);
    this.focusResolve?.(false);
    this.focusResolve = null;
    this.canvas.removeEventListener("pointermove", this._onPointerMove);
    this.canvas.removeEventListener("pointerleave", this._onPointerLeave);
    this.canvas.removeEventListener("pointerdown", this._onPointerDown);
    this.canvas.removeEventListener("pointerup", this._onPointerUp);
    this.canvas.removeEventListener("pointercancel", this._onPointerCancel);
    globalThis.removeEventListener("resize", this._onWindowResize);
    this.resizeObserver?.disconnect();
    this.canvas.style.cursor = "";

    if (globalThis.__STAR_BOTTLE_SCENE__ === this) delete globalThis.__STAR_BOTTLE_SCENE__;
    if (globalThis.__STAR_BOTTLE_DEBUG__ === this.debugSurface) delete globalThis.__STAR_BOTTLE_DEBUG__;
    if (!this.initialized) return;

    this.scene.traverse((object) => {
      object.geometry?.dispose?.();
      if (Array.isArray(object.material)) {
        object.material.forEach((material) => material.dispose?.());
      } else {
        object.material?.dispose?.();
      }
    });
    this.renderer.dispose();
    if (this.world) {
      for (const body of [...this.world.bodies]) this.world.removeBody(body);
    }
    this.records.length = 0;
    this.noteIndex.clear();
    this.clearPetWorldPosition();
    for (const texture of this.petTextureCache.values()) texture.dispose?.();
    this.petTextureCache.clear();
  }
}

export default StarBottleScene;
