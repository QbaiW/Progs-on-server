"use strict";

// This is the only catalog a new feature needs to join. Public metadata is
// exposed through GET /api/features; entry stays server-side.
module.exports = Object.freeze([
  Object.freeze({
    id: "star-bottle",
    title: "星星瓶",
    description: "从星河里挑一颗星星，打开一张给圆圆宝宝的纸条。",
    icon: "✦",
    path: "/star-bottle",
    entry: "/index.html",
    order: 10,
    enabled: true,
  }),
  Object.freeze({
    id: "love-stars",
    title: "七夕星空情书",
    description: "旋转视角，在星尘与双星之间发现一封隐藏的告白。",
    icon: "☆",
    path: "/love-stars",
    entry: "/love-stars/index.html",
    order: 20,
    enabled: true,
  }),
  Object.freeze({
    id: "wrong",
    title: "严格教育现场",
    description: "点击舞台，看圆圆宝宝拿小锤子敲打 QE。",
    icon: "✧",
    path: "/wrong",
    entry: "/wrong/index.html",
    order: 30,
    enabled: true,
  }),
  Object.freeze({
    id: "world",
    title: "星空世界",
    description: "点进去就能玩的 3D 联机世界，朋友们可以一起走动、聊天、放模型。",
    icon: "✵",
    path: "/world",
    entry: "/world/index.html",
    order: 40,
    enabled: true,
  }),
]);
