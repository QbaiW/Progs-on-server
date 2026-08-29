/* ============================================================
   七夕星空情书 — 主逻辑 (frontend/main.js)
   - 三层空间：远方星座区 / 中央双星区 / 后方牛郎织女区
   - 远方星座区：悬停星点显示主星连线
   - 后方故事区：悬停星点显示牛郎织女的连接图案
   - 右下角留言：调用 love-stars 命名空间 API (/api/love-stars/message)
   ============================================================ */
(function () {
  'use strict';

  // ---------------- 配置 ----------------
  var STAR_BRIGHT = 350;               // 亮星（大、暖白，闪烁）
  var STAR_COLOR = 40;                 // 彩星（红/蓝/金点缀）
  var STAR_MID = 1800;                 // 中星（蓝白）
  var STAR_DIM = 4500;                 // 暗星（细小微尘）
  var BINARY_ORBIT_R = 6.4;            // 双星公转轨道半径
  var BINARY_SPEED = 0.35;             // 公转速度 (rad/s)
  var SKY_ROTATE_SPEED = 0.006;        // 远方/后方区域缓慢自转
  var FAR_RADIUS = 104;                // 前方双子/狮子星座区半径
  var REAR_RADIUS = 178;                // 后方牛郎织女区半径（明显更深）
  var REAR_ART_SCALE = 2.1;             // 后方图案的切平面放大，抵消更远半径
  var CAMERA_START = { x: -6, y: 12, z: 30 }; // 初始视角（中央双星 + 远方星座）
  var API_BASE = '';                   // 同域 API，留空
  var MESSAGE_API_PATH = '/api/love-stars/message';
  var DEFAULT_LOVE_NOTE = '宝宝，我们就像两个相互环绕的星星呀，相互照亮对方，温暖对方，永远都不会分开。\n我的宝贝，七夕节快乐，外脑，永远永远';

  // ---------------- DOM ----------------
  var container = document.getElementById('scene-container');
  var loadingEl = document.getElementById('loading');
  var labelEl = document.getElementById('constellation-label');
  var loveNoteEl = document.getElementById('love-note');
  var loveNoteText = document.getElementById('love-note-text');
  var loveNoteEdit = document.getElementById('love-note-edit');
  var loveNoteInput = document.getElementById('love-note-input');
  var loveNoteSave = document.getElementById('love-note-save');
  var loveNoteStatus = document.getElementById('love-note-status');

  // ---------------- 3D 状态 ----------------
  var scene, camera, renderer, controls;
  var skyGroup;                        // 远端内容总组
  var farZone;                         // 前区块：远方星座与背景星
  var centerZone;                      // 中区块：两颗恒星
  var rearZone;                        // 后区块：牛郎织女故事星点
  var starA, starB, glowA, glowB;      // 双星及其光晕
  var brightMat, colorMat, midMat, dimMat; // 分层星场材质（闪烁用）
  var geminiPoints, geminiMaterial, geminiLines, geminiCenter3d;
  var leoPoints, leoMaterial, leoLines, leoCenter3d;
  var njPoints, njMaterial, njLines, njCenter3d;
  var constellationTargets = [];
  var clock = null;
  var rafId = null;
  var orbitAngle = 0;

  // hover 状态
  var raycaster = new THREE.Raycaster();
  raycaster.params.Points.threshold = 1.0;
  var mouse = new THREE.Vector2();
  var pointerReady = false;
  var currentGroup = null;             // constellation id | 'niulang' | null

  // ---------------- 工具函数 ----------------
  function api(path, options) {
    return fetch(API_BASE + path, options);
  }

  // 球坐标（theta: x-z 平面方位角，phi: 与 y 轴夹角），返回 Vector3
  function spherePoint(r, thetaDeg, phiDeg) {
    var th = thetaDeg * Math.PI / 180;
    var ph = phiDeg * Math.PI / 180;
    return new THREE.Vector3(
      r * Math.sin(ph) * Math.cos(th),
      r * Math.cos(ph),
      r * Math.sin(ph) * Math.sin(th)
    );
  }

  // 相机位于天球内部，因此首屏看到的是沿视线方向的内壁；
  // 用这套屏幕坐标把远方星座放在首屏，把牛郎织女放到水平反侧。
  function getViewFrame() {
    var face = camera.position.clone().negate().normalize();
    var right = new THREE.Vector3()
      .crossVectors(face, new THREE.Vector3(0, 1, 0))
      .normalize();
    var up = new THREE.Vector3().crossVectors(right, face).normalize();
    return { face: face, right: right, up: up };
  }

  // ---------------- 纹理：柔和光点 ----------------
  function makeGlowTexture() {
    var c = document.createElement('canvas');
    c.width = c.height = 128;
    var ctx = c.getContext('2d');
    var g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.3, 'rgba(255,255,255,0.7)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    var tex = new THREE.Texture(c);
    tex.needsUpdate = true;
    return tex;
  }

  // ---------------- 分层星场（天球） ----------------
  // 固定种子让星图刷新后保持一致；低差异采样 + 银河带/小星簇避免均匀噪点感。
  function seededRandom(seed) {
    return function () {
      var x = Math.sin(seed++) * 43758.5453123;
      return x - Math.floor(x);
    };
  }

  function starDirection(index, count, random, seed) {
    var golden = Math.PI * (3 - Math.sqrt(5));
    var theta = index * golden + (random() - 0.5) * 0.42;
    var fraction = (index + 0.5) / count;
    var latitude = Math.asin(1 - 2 * fraction);
    var band = index % 11;

    // 一条松散的银河带，让星场有视觉主轴但不遮满整个天球。
    if (band < 2) {
      latitude = (random() - 0.5) * 0.34 + 0.08 * Math.sin(theta * 2 + seed);
    // 少量稳定星簇，给亮星和中星留下自然的密度变化。
    } else if (band === 2) {
      var anchors = [
        [0.45, 0.24], [1.65, -0.18], [2.85, 0.31],
        [4.05, -0.22], [5.15, 0.17], [5.8, -0.3]
      ];
      var anchor = anchors[Math.floor(index / 11) % anchors.length];
      theta = anchor[0] + (random() - 0.5) * 0.28;
      latitude = anchor[1] + (random() - 0.5) * 0.2;
    } else {
      latitude += (random() - 0.5) * 0.045;
    }

    return { theta: theta, latitude: latitude };
  }

  function buildStarLayer(count, minR, maxR, seed) {
    var positions = new Float32Array(count * 3);
    var random = seededRandom(seed);
    for (var i = 0; i < count; i++) {
      var direction = starDirection(i, count, random, seed);
      var r = minR + (0.12 + Math.pow(random(), 0.78) * 0.88) * (maxR - minR);
      var cosLat = Math.cos(direction.latitude);
      positions[i * 3] = r * cosLat * Math.cos(direction.theta);
      positions[i * 3 + 1] = r * Math.sin(direction.latitude);
      positions[i * 3 + 2] = r * cosLat * Math.sin(direction.theta);
    }
    return positions;
  }

  // 彩星：红/蓝/金三色点缀（vertexColors）
  function buildColorStars() {
    var count = STAR_COLOR;
    var positions = new Float32Array(count * 3);
    var colors = new Float32Array(count * 3);
    var random = seededRandom(71);
    var palette = [
      [1.0, 0.62, 0.62],  // 红
      [0.62, 0.78, 1.0],  // 蓝
      [1.0, 0.91, 0.69]   // 金
    ];
    for (var i = 0; i < count; i++) {
      var direction = starDirection(i, count, random, 71);
      var r = 45 + (0.15 + Math.pow(random(), 0.72) * 0.85) * 40;
      var cosLat = Math.cos(direction.latitude);
      positions[i * 3] = r * cosLat * Math.cos(direction.theta);
      positions[i * 3 + 1] = r * Math.sin(direction.latitude);
      positions[i * 3 + 2] = r * cosLat * Math.sin(direction.theta);
      var c = palette[Math.floor(random() * palette.length)];
      colors[i * 3] = c[0];
      colors[i * 3 + 1] = c[1];
      colors[i * 3 + 2] = c[2];
    }
    return { positions: positions, colors: colors };
  }

  // ---------------- 双星系统 ----------------
  function buildBinaryStars() {
    var geo = new THREE.SphereGeometry(1.8, 40, 40);

    starA = new THREE.Mesh(geo, new THREE.MeshPhongMaterial({
      color: 0xff9f4d, emissive: 0xa84013, emissiveIntensity: 0.38,
      specular: 0xffefcb, shininess: 85
    }));
    starB = new THREE.Mesh(geo.clone(), new THREE.MeshPhongMaterial({
      color: 0x4f9ff3, emissive: 0x154fbb, emissiveIntensity: 0.34,
      specular: 0xe1f4ff, shininess: 92
    }));

    var glowTex = makeGlowTexture();
    glowA = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xff9c58, transparent: true, opacity: 0.62,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    glowA.scale.set(20, 20, 1);
    glowB = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0x4c9fff, transparent: true, opacity: 0.62,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    glowB.scale.set(20, 20, 1);

    // 双星只属于中央区，不随远端星空旋转。
    centerZone.add(starA, starB, glowA, glowB);

    // 小范围主光保留球面的明暗和高光，让恒星看起来有体积而非纯色圆片。
    var keyLight = new THREE.PointLight(0xffefd3, 2.2, 42);
    keyLight.position.set(-8, 10, 16);
    var fillLight = new THREE.PointLight(0x75bbff, 1.35, 36);
    fillLight.position.set(10, -4, 11);
    centerZone.add(new THREE.AmbientLight(0x413858, 0.7), keyLight, fillLight);

  }

  function updateBinaryOrbit(delta) {
    orbitAngle += delta * BINARY_SPEED;
    var r = BINARY_ORBIT_R;
    starA.position.set(Math.cos(orbitAngle) * r, 0, Math.sin(orbitAngle) * r);
    starB.position.set(-Math.cos(orbitAngle) * r, 0, -Math.sin(orbitAngle) * r);
    glowA.position.copy(starA.position);
    glowB.position.copy(starB.position);
  }

  // ---------------- 星座：把局部 (dx, dy) 星点放到天球某方向 ----------------
  function buildSkyStars(localStars, centerDir, radius, scale, size, color, opacity) {
    var U = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), centerDir).normalize();
    var V = new THREE.Vector3().crossVectors(centerDir, U).normalize();
    var positions = new Float32Array(localStars.length * 3);
    for (var i = 0; i < localStars.length; i++) {
      // 先把中心方向放到实际半径，再叠加切平面偏移；否则用单位向量叠加
      // 世界坐标会把一个星座错误地摊成半个天球。
      var dir = centerDir.clone().multiplyScalar(radius)
        .addScaledVector(U, localStars[i][0] * scale)
        .addScaledVector(V, localStars[i][1] * scale)
        .normalize()
        .multiplyScalar(radius);
      positions[i * 3] = dir.x;
      positions[i * 3 + 1] = dir.y;
      positions[i * 3 + 2] = dir.z;
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      size: size, color: color, transparent: true, opacity: opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    return new THREE.Points(geo, mat);
  }

  // 星座主星连线（LineSegments）
  function buildConstellationLines(starPositions, pairs, color) {
    var arr = [];
    for (var p = 0; p < pairs.length; p++) {
      var i = pairs[p][0], j = pairs[p][1];
      arr.push(starPositions[i].x, starPositions[i].y, starPositions[i].z);
      arr.push(starPositions[j].x, starPositions[j].y, starPositions[j].z);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
    return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
      color: color, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
  }

  function registerConstellation(id, label, localStars, pairs, direction, color, lineColor, scale, opacity, pointSize) {
    var center = direction.clone().normalize();
    var points = buildSkyStars(localStars, center, FAR_RADIUS, scale, pointSize || 1.1, color, opacity);
    points.name = id + '-stars';
    points.renderOrder = 4;

    var pointPositions = points.geometry.attributes.position.array;
    var pointVectors = [];
    for (var i = 0; i < pointPositions.length; i += 3) {
      pointVectors.push(new THREE.Vector3(
        pointPositions[i], pointPositions[i + 1], pointPositions[i + 2]
      ));
    }
    var lines = buildConstellationLines(pointVectors, pairs, lineColor);
    lines.name = id + '-connections';
    lines.visible = false;
    lines.renderOrder = 5;
    lines.material.depthTest = false;

    var pick = new THREE.Mesh(
      new THREE.SphereGeometry(7.5, 12, 8),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    pick.name = id + '-hover-target';
    pick.position.copy(center).multiplyScalar(FAR_RADIUS);
    pick.userData.hoverId = id;

    farZone.add(points, lines, pick);
    var target = {
      id: id,
      label: label,
      points: points,
      material: points.material,
      lines: lines,
      center: center.clone().multiplyScalar(FAR_RADIUS),
      parent: farZone,
      pick: pick,
      baseOpacity: opacity,
      baseSize: pointSize || 1.1,
      hitRadius: opacity > 0.9 ? 120 : 85
    };
    constellationTargets.push(target);
    return target;
  }

  function buildConstellations() {
    constellationTargets = [];

    var frame = getViewFrame();
    var geminiDirection = frame.face.clone()
      .addScaledVector(frame.right, -0.32)
      .addScaledVector(frame.up, 0.08)
      .normalize();
    var leoDirection = frame.face.clone()
      .addScaledVector(frame.right, 0.32)
      .addScaledVector(frame.up, -0.06)
      .normalize();

    // 双子座：只保留参考图中的主星点与稀疏骨架连线，不绘制人物轮廓。
    var gemini = registerConstellation(
      'gemini', '双子座 Gemini ♊',
      [
        [-1.05, 3.05], [-0.98, 2.32], [-2.05, 2.38], [-0.27, 2.02],
        [-1.53, 0.55], [-2.87, -0.56], [-1.11, -0.58], [-2.13, -3.09],
        [-0.82, -2.84], [0.47, 3.24], [1.04, 1.71], [2.87, 1.60],
        [1.04, -0.64], [0.58, -2.36], [1.49, -2.20], [1.89, -2.58],
        [2.69, -3.00]
      ],
      [
        [0, 1], [2, 1], [1, 3], [3, 10], [9, 10], [10, 11],
        [1, 4], [4, 5], [5, 7], [4, 6], [6, 8],
        [10, 12], [12, 13], [12, 14], [14, 15], [15, 16]
      ],
      geminiDirection, 0xfff2cc, 0x8bd9ff, 5.2, 1, 1.2
    );
    geminiPoints = gemini.points;
    geminiMaterial = gemini.material;
    geminiLines = gemini.lines;
    geminiCenter3d = gemini.center;

    // 狮子座：只保留参考图中的 9 个主星点与骨架连线，不绘制狮子轮廓。
    var leo = registerConstellation(
      'leo', '狮子座 Leo ♌',
      [
        [-3.04, -3.06], [-1.46, -0.54], [-1.04, -1.96],
        [1.60, 0.69], [1.42, 1.73], [2.33, 3.08],
        [2.92, 2.75], [2.60, 0.35], [3.04, -0.94]
      ],
      [
        [0, 1], [0, 2], [1, 2], [1, 3], [2, 8],
        [3, 4], [4, 5], [5, 6], [3, 7], [7, 8]
      ],
      leoDirection, 0xffe9c9, 0xffc184, 5.2, 1, 1.35
    );
    leoPoints = leo.points;
    leoMaterial = leo.material;
    leoLines = leo.lines;
    leoCenter3d = leo.center;

    // 前方只保留双子座和狮子座，避免其它具名轮廓分散焦点。
  }

  // ---------------- 牛郎织女：轮廓星点 ----------------
  function drawPersonOutline(ctx, x, y, face, isGirl) {
    var dir = face === 'left' ? 1 : -1;
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.arc(x, y, 22, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x, y + 22);
    ctx.lineTo(x, y + 72);
    ctx.stroke();
    if (isGirl) {
      ctx.beginPath();
      ctx.moveTo(x, y + 58);
      ctx.lineTo(x - 26, y + 108);
      ctx.lineTo(x + 26, y + 108);
      ctx.lineTo(x, y + 58);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(x, y + 72);
      ctx.lineTo(x - 15, y + 108);
      ctx.moveTo(x, y + 72);
      ctx.lineTo(x + 15, y + 108);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(x, y + 38);
    ctx.lineTo(x + dir * 70, y + 52);
    ctx.stroke();
    ctx.restore();
  }

  function drawBridge(ctx) {
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(245, 158);
    ctx.quadraticCurveTo(400, 70, 555, 158);
    ctx.stroke();
    ctx.restore();
  }

  function drawHeart(ctx, cx, cy, size) {
    ctx.save();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx, cy + size * 0.9);
    ctx.bezierCurveTo(cx - size * 1.8, cy - size * 0.1, cx - size * 0.8, cy - size * 1.3, cx, cy - size * 0.2);
    ctx.bezierCurveTo(cx + size * 0.8, cy - size * 1.3, cx + size * 1.8, cy - size * 0.1, cx, cy + size * 0.9);
    ctx.stroke();
    ctx.restore();
  }

  function buildNiulangZhinu() {
    // 1. Canvas 绘制图案
    var canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 320;
    var ctx = canvas.getContext('2d');
    // 后区只保留牛郎、织女、鹊桥和爱心的轮廓，避免默认状态出现实心图案。
    drawPersonOutline(ctx, 170, 110, 'left', false);
    drawPersonOutline(ctx, 630, 110, 'right', true);
    drawBridge(ctx);
    drawHeart(ctx, 400, 92, 26);

    // 2. 只提取轮廓点：内部填充全部丢弃，默认状态只留下人物/桥/爱心的边缘星点。
    var img = ctx.getImageData(0, 0, 800, 320);
    var data = img.data;
    var canvasWidth = 800;
    var canvasHeight = 320;
    var outlineMask = new Uint8Array(canvasWidth * canvasHeight);
    var total = 0;
    function alphaAt(x, y) {
      if (x < 0 || x >= canvasWidth || y < 0 || y >= canvasHeight) return 0;
      return data[(y * canvasWidth + x) * 4 + 3];
    }
    for (var yy = 0; yy < canvasHeight; yy++) {
      for (var xx = 0; xx < canvasWidth; xx++) {
        if (alphaAt(xx, yy) <= 128) continue;
        var edge = alphaAt(xx - 1, yy - 1) <= 128 || alphaAt(xx, yy - 1) <= 128 ||
          alphaAt(xx + 1, yy - 1) <= 128 || alphaAt(xx - 1, yy) <= 128 ||
          alphaAt(xx + 1, yy) <= 128 || alphaAt(xx - 1, yy + 1) <= 128 ||
          alphaAt(xx, yy + 1) <= 128 || alphaAt(xx + 1, yy + 1) <= 128;
        if (edge) {
          outlineMask[yy * canvasWidth + xx] = 1;
          total++;
        }
      }
    }
    var step = 1;
    while (total / (step * step) > 4500) step++;

    var points = [];
    var scale = 800 / 36; // 图案世界宽度约 36 单位
    var samples = [];
    var sampleIndex = Object.create(null);
    for (var y = 0; y < canvasHeight; y += step) {
      for (var x = 0; x < canvasWidth; x += step) {
        if (outlineMask[y * canvasWidth + x]) {
          var pointIndex = points.length / 2;
          points.push((x - 400) / scale, -(y - 160) / scale);
          samples.push({ x: x, y: y, index: pointIndex });
          sampleIndex[x + ':' + y] = pointIndex;
        }
      }
    }

    // 3. 映射到后方区块；与初始星座区隔开，旋转后才能看到。
    // 远方星座区的反方向：后方区必须旋转约半圈才会进入视野。
    // 旧蓝皮书曾使用 theta=205；三层布局改为与首屏星座同纬度的反向区域。
    var frame = getViewFrame();
    var center = new THREE.Vector3(-frame.face.x, 0, -frame.face.z).normalize();
    var U = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), center).normalize();
    var V = new THREE.Vector3().crossVectors(center, U).normalize();
    var pointCount = Math.floor(points.length / 2);
    var positions = new Float32Array(pointCount * 3);
    for (var i = 0; i < pointCount; i++) {
      var source = i * 2;
      var dir = center.clone().multiplyScalar(REAR_RADIUS)
        .addScaledVector(U, points[source] * REAR_ART_SCALE)
        .addScaledVector(V, points[source + 1] * REAR_ART_SCALE)
        .normalize()
        .multiplyScalar(REAR_RADIUS);
      positions[i * 3] = dir.x;
      positions[i * 3 + 1] = dir.y;
      positions[i * 3 + 2] = dir.z;
    }

    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    var mat = new THREE.PointsMaterial({
      size: 0.52, map: makeGlowTexture(), color: 0xffe9d2, transparent: true, opacity: 0.78,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    njCenter3d = center.clone().multiplyScalar(REAR_RADIUS);
    njPoints = new THREE.Points(geo, mat);
    njMaterial = mat;
    njPoints.renderOrder = 4;

    // 默认只看到稀疏星点；悬停时用二维相邻星点的线段勾勒整幅相会画面。
    var outline = [];
    var neighborOffsets = [
      [step, 0], [0, step], [step, step], [-step, step]
    ];
    samples.forEach(function (sample) {
      neighborOffsets.forEach(function (offset) {
        var neighbor = sampleIndex[(sample.x + offset[0]) + ':' + (sample.y + offset[1])];
        if (typeof neighbor !== 'number') return;
        outline.push(
          positions[sample.index * 3], positions[sample.index * 3 + 1], positions[sample.index * 3 + 2],
          positions[neighbor * 3], positions[neighbor * 3 + 1], positions[neighbor * 3 + 2]
        );
      });
    });
    var outlineGeo = new THREE.BufferGeometry();
    outlineGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(outline), 3));
    njLines = new THREE.LineSegments(outlineGeo, new THREE.LineBasicMaterial({
      color: 0xffd8ba, transparent: true, opacity: 0.72,
      blending: THREE.AdditiveBlending, depthWrite: false
    }));
    njLines.material.depthTest = false;
    njLines.visible = false;
    njLines.renderOrder = 5;
    var njPick = new THREE.Mesh(
      new THREE.SphereGeometry(44, 16, 12),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    njPick.name = 'niulang-hover-target';
    njPick.position.copy(njCenter3d);
    njPick.userData.hoverId = 'niulang';
    rearZone.add(njPoints, njLines, njPick);
    constellationTargets.push({
      id: 'niulang',
      label: '牛郎织女 · 鹊桥相会',
      points: njPoints,
      material: njMaterial,
      lines: njLines,
      center: njCenter3d,
      parent: rearZone,
      pick: njPick,
      baseOpacity: 0.78,
      baseSize: 0.52,
      hitRadius: 190
    });
  }

  // ---------------- 场景初始化 ----------------
  function getViewportSize() {
    var viewport = window.visualViewport;
    var width = viewport && viewport.width || document.documentElement.clientWidth || window.innerWidth;
    var height = viewport && viewport.height || document.documentElement.clientHeight || window.innerHeight;
    return { width: Math.max(1, width), height: Math.max(1, height) };
  }

  function init() {
    if (typeof THREE === 'undefined') {
      loadingEl.querySelector('p').textContent = '星图加载失败：需要网络加载 Three.js，请刷新重试';
      return;
    }

    scene = new THREE.Scene();
    clock = new THREE.Clock();

    var viewport = getViewportSize();
    camera = new THREE.PerspectiveCamera(60, viewport.width / viewport.height, 0.1, 500);
    camera.position.set(CAMERA_START.x, CAMERA_START.y, CAMERA_START.z);
    camera.lookAt(0, 0, 0);

    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(viewport.width, viewport.height);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 18;
    controls.maxDistance = 70;
    controls.rotateSpeed = 0.55;
    controls.update();

    // 三个清晰的空间区块：远方内容缓慢旋转，中央双星保持稳定。
    skyGroup = new THREE.Group();
    skyGroup.name = 'remote-zones';
    farZone = new THREE.Group();
    farZone.name = 'far-constellations-zone';
    farZone.userData.zone = 'far';
    rearZone = new THREE.Group();
    rearZone.name = 'rear-love-story-zone';
    rearZone.userData.zone = 'rear';
    centerZone = new THREE.Group();
    centerZone.name = 'center-binary-zone';
    centerZone.userData.zone = 'center';
    skyGroup.add(farZone, rearZone);
    scene.add(skyGroup, centerZone);

    // 分层星场：亮星 / 彩星 / 中星 / 暗星（大小与颜色层次分明）
    var glowTex = makeGlowTexture();

    var brightGeo = new THREE.BufferGeometry();
    brightGeo.setAttribute('position', new THREE.BufferAttribute(buildStarLayer(STAR_BRIGHT, 72, 112, 11), 3));
    brightMat = new THREE.PointsMaterial({
      size: 0.6, map: glowTex, color: 0xfff2cc, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    farZone.add(new THREE.Points(brightGeo, brightMat));

    var colorStars = buildColorStars();
    var colorGeo = new THREE.BufferGeometry();
    colorGeo.setAttribute('position', new THREE.BufferAttribute(colorStars.positions, 3));
    colorGeo.setAttribute('color', new THREE.BufferAttribute(colorStars.colors, 3));
    colorMat = new THREE.PointsMaterial({
      size: 0.9, map: glowTex, vertexColors: true, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    farZone.add(new THREE.Points(colorGeo, colorMat));

    var midGeo = new THREE.BufferGeometry();
    midGeo.setAttribute('position', new THREE.BufferAttribute(buildStarLayer(STAR_MID, 70, 116, 23), 3));
    midMat = new THREE.PointsMaterial({
      size: 0.28, map: glowTex, color: 0xcfe0ff, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    farZone.add(new THREE.Points(midGeo, midMat));

    var dimGeo = new THREE.BufferGeometry();
    dimGeo.setAttribute('position', new THREE.BufferAttribute(buildStarLayer(STAR_DIM, 76, 124, 37), 3));
    dimMat = new THREE.PointsMaterial({
      size: 0.13, map: glowTex, color: 0x7d8fc4, transparent: true, opacity: 0.7,
      blending: THREE.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    farZone.add(new THREE.Points(dimGeo, dimMat));

    // 双星
    buildBinaryStars();
    // 星座
    buildConstellations();
    // 牛郎织女
    buildNiulangZhinu();

    window.addEventListener('resize', onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', onResize);
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerleave', function () {
      pointerReady = false;
      setHover(null);
    });
    animate();

    setTimeout(function () { loadingEl.classList.add('done'); }, 350);
  }

  // ---------------- 窗口缩放 ----------------
  function onResize() {
    var viewport = getViewportSize();
    camera.aspect = viewport.width / viewport.height;
    camera.updateProjectionMatrix();
    renderer.setSize(viewport.width, viewport.height);
  }

  // ---------------- hover：显示星象 ----------------
  function onPointerMove(e) {
    var rect = renderer.domElement.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    pointerReady = true;
    updateHover();
  }

  function updateHover() {
    if (!camera) return;
    raycaster.setFromCamera(mouse, camera);
    var pickObjects = constellationTargets.map(function (target) { return target.pick; });
    var hits = raycaster.intersectObjects(pickObjects, false);
    var target = hits.length ? constellationTargets.find(function (item) {
      return item.pick === hits[0].object;
    }) : null;

    // 射线碰到透明拾取球后仍可能因深度/半径落空，补一个屏幕空间热区，
    // 让“鼠标放上去”对应整个星座，而不是必须点中单颗小星。
    if (!target) {
      var px = (mouse.x * 0.5 + 0.5) * window.innerWidth;
      var py = (-mouse.y * 0.5 + 0.5) * window.innerHeight;
      var nearest = null;
      var nearestDistance = Infinity;
      constellationTargets.forEach(function (item) {
        var projected = projectPointData(item.center, item.parent);
        if (!projected.visible) return;
        var dx = projected.x - px;
        var dy = projected.y - py;
        var distance = Math.sqrt(dx * dx + dy * dy);
        if (distance <= item.hitRadius && distance < nearestDistance) {
          nearest = item;
          nearestDistance = distance;
        }
      });
      target = nearest;
    }
    setHover(target ? target.id : null);
  }

  function setHover(group) {
    if (group === currentGroup) return;
    currentGroup = group;

    constellationTargets.forEach(function (target) {
      var active = target.id === group;
      target.lines.visible = active;
      target.material.size = active ? target.baseSize * 1.75 : target.baseSize;
      target.material.opacity = active ? 1 : target.baseOpacity;
    });

    // 悬停只改变点的亮度和连线，不显示任何中文注释。
    hideLabel();
  }

  function projectPoint(v3, parent) {
    var projected = projectPointData(v3, parent);
    return { x: projected.x, y: projected.y };
  }

  function projectPointData(v3, parent) {
    var world = v3.clone();
    var transformParent = parent || skyGroup;
    if (transformParent) {
      transformParent.updateMatrixWorld(true);
      transformParent.localToWorld(world);
    }
    var p = world.project(camera);
    return {
      x: (p.x * 0.5 + 0.5) * window.innerWidth,
      y: (-p.y * 0.5 + 0.5) * window.innerHeight,
      visible: p.z >= -1 && p.z <= 1
    };
  }

  function showLabel(text, pos) {
    // 交互仅通过点亮和连线反馈；所有星图都不显示中文注释。
    hideLabel();
  }

  function hideLabel() {
    labelEl.hidden = true;
  }

  function updateActiveLabel() {
    // 保留更新钩子以兼容旧页面结构，但所有图像均不显示悬停文字。
    hideLabel();
  }

  // ---------------- 渲染循环 ----------------
  function animate() {
    rafId = requestAnimationFrame(animate);
    var delta = clock.getDelta();
    var t = clock.getElapsedTime();

    // 双星公转
    updateBinaryOrbit(delta);

    // 光晕呼吸
    var breathe = 1 + 0.08 * Math.sin(t * 1.8);
    glowA.scale.set(20 * breathe, 20 * breathe, 1);
    glowB.scale.set(20 * (2 - breathe), 20 * (2 - breathe), 1);

    // 星星闪烁：各层错相呼吸（大小层次 + 亮度起伏 = 星空感）
    brightMat.opacity = 0.95 + 0.05 * Math.sin(t * 1.3);
    colorMat.opacity = 0.9 + 0.1 * Math.sin(t * 1.7 + 1.2);
    midMat.opacity = 0.8 + 0.15 * Math.sin(t * 0.9 + 2.6);
    dimMat.opacity = 0.65 + 0.2 * Math.sin(t * 0.6 + 4.1);

    // 天球缓转（星空、星座、牛郎织女一起转）
    skyGroup.rotation.y = t * SKY_ROTATE_SPEED;
    controls.update();
    if (pointerReady) updateHover();
    updateActiveLabel();

    renderer.render(scene, camera);
  }

  // ---------------- 右下角留言气泡 ----------------
  // 连点 4 次进入编辑；未编辑过时显示默认留言
  function initLoveNote() {
    // 加载最近一条留言（若有），否则保持默认留言
    api(MESSAGE_API_PATH)
      .then(function (r) { return r.json(); })
      .then(function (d) {
        var list = (d && d.messages) || [];
        if (list.length && list[0].content) {
          loveNoteText.textContent = list[0].content;
        }
      })
      .catch(function () {});

    // 600ms 内连续点击 4 次 → 进入编辑
    var clicks = 0;
    var clickTimer = null;
    loveNoteEl.addEventListener('click', function () {
      clicks++;
      if (!clickTimer) {
        clickTimer = setTimeout(function () { clicks = 0; clickTimer = null; }, 600);
      }
      if (clicks >= 4) {
        enterNoteEdit();
        clicks = 0;
        clearTimeout(clickTimer);
        clickTimer = null;
      }
    });

    loveNoteSave.addEventListener('click', saveNote);
    loveNoteInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); saveNote(); }
    });
    loveNoteInput.addEventListener('blur', function () {
      // 延迟收起，避免点击"保存"时编辑框先消失
      setTimeout(function () {
        if (document.activeElement !== loveNoteInput) {
          loveNoteEdit.hidden = true;
          loveNoteEl.hidden = false;
        }
      }, 150);
    });
  }

  function enterNoteEdit() {
    loveNoteInput.value = loveNoteText.textContent;
    setNoteStatus('');
    loveNoteEl.hidden = true;
    loveNoteEdit.hidden = false;
    loveNoteInput.focus();
    loveNoteInput.select();
  }

  function setNoteStatus(message) {
    if (!loveNoteStatus) return;
    loveNoteStatus.textContent = message || '';
    loveNoteStatus.hidden = !message;
  }

  function saveNote() {
    var content = loveNoteInput.value.trim();
    if (!content) content = DEFAULT_LOVE_NOTE; // 留空则恢复默认
    if (content.length > 200) {
      setNoteStatus('留言不能超过 200 字');
      return;
    }

    setNoteStatus('');
    loveNoteSave.disabled = true;
    api(MESSAGE_API_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: content })
    })
      .then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (d) {
        if (d && d.success) {
          loveNoteText.textContent = content;
          setNoteStatus('');
          loveNoteEdit.hidden = true;
          loveNoteEl.hidden = false;
        } else {
          // 失败（如 10 秒防刷）时保留编辑态，稍后可直接再保存
          setNoteStatus((d && d.error) || '保存失败，稍后再试');
          loveNoteInput.focus();
        }
      })
      .catch(function () {
        setNoteStatus('网络开小差了，稍后再试');
        loveNoteInput.focus();
      })
      .finally(function () { loveNoteSave.disabled = false; });
  }

  // ---------------- 启动 ----------------
  init();
  initLoveNote();
})();
