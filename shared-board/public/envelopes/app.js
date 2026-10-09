"use strict";

const grid = document.getElementById("memo-grid");
const boardStatus = document.getElementById("board-status");
const editor = document.getElementById("editor");
const titleInput = document.getElementById("memo-title");
const blockArea = document.getElementById("editor-body");
const editorState = document.getElementById("editor-state");
const editorError = document.getElementById("editor-error");
const imageInput = document.getElementById("image-input");
const formatOptions = document.getElementById("format-options");
const formatButtons = [...document.querySelectorAll(".format-button")];
const formatLabel = document.querySelector(".format-label");
const panel = document.getElementById("editor-panel");
const readerTitle = document.getElementById("reader-title");
const readerBody = document.getElementById("reader-body");
const readerState = document.getElementById("reader-state");
const editButton = document.getElementById("edit-memo");

const EMPTY_TEXT = "还什么都没有写";

let memos = [];
let currentId = null;
let dirty = false;
let activeRow = null;
let currentBlocks = [];
/* 编辑器里现在装的是哪个信封的内容；切回阅读再切回来时不重建，免得丢掉没保存的改动。 */
let writerId = null;

async function api(pathname, options = {}) {
  const response = await fetch(pathname, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401) {
    window.location.replace(`/login?return=${encodeURIComponent("/envelopes")}`);
    throw new Error("登录已过期");
  }
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || "请求失败");
  return payload;
}

function jsonOptions(method, body) {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (number) => String(number).padStart(2, "0");
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function plainText(text) {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[#>*`_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function textOf(memo) {
  return memo.blocks
    .filter((block) => block.type === "text")
    .map((block) => (block.format === "md" ? plainText(block.text) : block.text))
    .join("\n")
    .trim();
}

function firstImage(memo) {
  const image = memo.blocks.find((block) => block.type === "image");
  return image ? image.url : "";
}

/* ---------- 看板 ---------- */

function renderGrid() {
  grid.replaceChildren();

  const addCard = document.createElement("button");
  addCard.type = "button";
  addCard.className = "memo-card memo-card-new";
  const plus = document.createElement("span");
  plus.className = "new-plus";
  plus.textContent = "＋";
  const label = document.createElement("span");
  label.className = "new-label";
  label.textContent = "新信封";
  addCard.append(plus, label);
  addCard.addEventListener("click", createMemo);
  grid.append(addCard);

  for (const memo of memos) {
    grid.append(memoCard(memo));
  }
}

function memoCard(memo) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "memo-card";

  const cover = document.createElement("div");
  cover.className = "memo-cover";
  const image = firstImage(memo);
  if (image) {
    const img = document.createElement("img");
    img.src = image;
    img.alt = "";
    img.loading = "lazy";
    cover.append(img);
  } else {
    cover.classList.add("memo-cover-text");
    cover.textContent = textOf(memo) || EMPTY_TEXT;
  }

  const meta = document.createElement("div");
  meta.className = "memo-meta";
  const heading = document.createElement("h2");
  heading.textContent = memo.title;
  const time = document.createElement("p");
  time.textContent = formatTime(memo.updatedAt);
  meta.append(heading, time);

  card.append(cover, meta);
  card.addEventListener("click", () => openMemo(memo));
  return card;
}

async function loadMemos() {
  try {
    const payload = await api("/api/envelopes");
    memos = payload.memos;
    boardStatus.textContent = "";
    renderGrid();
  } catch (error) {
    boardStatus.textContent = error.message;
  }
}

async function createMemo() {
  try {
    const payload = await api(
      "/api/envelopes",
      jsonOptions("POST", { title: "新信封", blocks: [] }),
    );
    memos = [payload.memo, ...memos];
    renderGrid();
    /* 新信封里还没东西可读，直接进编辑。 */
    openMemo(payload.memo, { editing: true });
  } catch (error) {
    boardStatus.textContent = error.message;
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function inlineMarkdown(escaped) {
  return escaped
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
    .replace(
      /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
    );
}

/* ponytail: 够用的 Markdown 子集，先转义再渲染，所以没有 XSS 面。 */
function renderMarkdown(source) {
  const html = [];
  let list = null;
  let fenced = false;
  const closeList = () => {
    if (list) html.push(`</${list}>`);
    list = null;
  };

  for (const line of escapeHtml(source).split("\n")) {
    if (line.trim().startsWith("```")) {
      closeList();
      fenced = !fenced;
      html.push(fenced ? "<pre><code>" : "</code></pre>");
      continue;
    }
    if (fenced) {
      html.push(`${line}\n`);
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      closeList();
      const level = heading[1].length + 1;
      html.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    /* 先整体转义过，所以引用行的 > 已经变成 &gt;。 */
    const quote = line.match(/^(?:&gt;|>)\s?(.*)$/);
    if (quote) {
      closeList();
      html.push(`<blockquote>${inlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(line)) {
      closeList();
      html.push("<hr>");
      continue;
    }
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || numbered) {
      const kind = bullet ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        html.push(`<${kind}>`);
        list = kind;
      }
      html.push(`<li>${inlineMarkdown((bullet || numbered)[1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) html.push(`<p>${inlineMarkdown(line)}</p>`);
  }

  closeList();
  if (fenced) html.push("</code></pre>");
  return html.join("");
}

/* ---------- 编辑 ---------- */

const FORMAT_OPTIONS = [
  ["text", "正文"],
  ["md", "Markdown"],
  ["title", "主标题"],
  ["subtitle", "副标题"],
];

const PLACEHOLDERS = {
  text: "写点什么…",
  md: "Markdown：**加粗**、- 列表、`代码`、> 引用",
  title: "主标题",
  subtitle: "副标题",
};

function removeButton(label) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "block-remove";
  button.textContent = "×";
  button.setAttribute("aria-label", label);
  return button;
}

function autoGrow(area) {
  area.style.height = "auto";
  area.style.height = `${area.scrollHeight}px`;
}

function isFormat(value) {
  return FORMAT_OPTIONS.some(([candidate]) => candidate === value);
}

function applyFormat(row, value) {
  const next = isFormat(value) ? value : "text";
  row.dataset.format = next;
  const area = row.querySelector("textarea");
  area.placeholder = PLACEHOLDERS[next] || PLACEHOLDERS.text;
  autoGrow(area);
}

function setActiveRow(row) {
  activeRow = row && row.isConnected ? row : null;
  syncFormatBar();
}

/* ponytail: 只在有焦点段落时改格式，省掉每段一套控件。 */
function syncFormatBar() {
  const active = activeRow ? activeRow.dataset.format : "";
  for (const button of formatButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.format === active));
  }
  formatLabel.textContent = activeRow ? "选中段落" : "先点进一段文字";
}

function textRow(block) {
  const row = document.createElement("div");
  row.className = "block";
  row.dataset.type = "text";
  row.dataset.format = isFormat(block.format) ? block.format : "text";

  const area = document.createElement("textarea");
  area.className = "block-text";
  area.rows = 1;
  area.value = block.text || "";
  area.setAttribute("aria-label", "信封文字");
  area.addEventListener("focus", () => setActiveRow(row));
  area.addEventListener("input", () => {
    autoGrow(area);
    markDirty();
  });

  const remove = removeButton("删除这段文字");
  remove.addEventListener("click", () => {
    row.remove();
    if (activeRow === row) setActiveRow(null);
    markDirty();
  });

  row.append(area, remove);
  applyFormat(row, row.dataset.format);
  return row;
}

function blockRow(block) {
  if (block.type === "image") {
    const row = document.createElement("div");
    row.className = "block";
    row.dataset.type = "image";
    row.dataset.url = block.url;
    const image = document.createElement("img");
    image.src = block.url;
    image.alt = "";
    image.loading = "lazy";
    const remove = removeButton("删除这张图片");
    remove.addEventListener("click", () => {
      row.remove();
      markDirty();
    });
    const tools = document.createElement("div");
    tools.className = "block-tools";
    tools.append(remove);
    row.append(image, tools);
    return row;
  }

  return textRow(block);
}

function addTextBlock(text = "") {
  const row = blockRow({ type: "text", text });
  blockArea.append(row);
  const area = row.querySelector("textarea");
  autoGrow(area);
  area.focus();
  return row;
}

function fillBlocks(blocks) {
  blockArea.replaceChildren();
  for (const block of blocks) {
    const row = blockRow(block);
    blockArea.append(row);
    // 行要先插进 DOM 再量高度，编辑器还 hidden 时 scrollHeight 是 0。
    const area = row.querySelector("textarea");
    if (area) autoGrow(area);
  }
  if (!blockArea.children.length) addTextBlock();
}

function setMode(mode) {
  panel.dataset.mode = mode;
}

/* ---------- 阅读 ---------- */

function renderReader(title, blocks) {
  readerTitle.textContent = title || "未命名信封";
  readerBody.replaceChildren();

  for (const block of blocks) {
    if (block.type === "image") {
      const image = document.createElement("img");
      image.src = block.url;
      image.alt = "";
      image.loading = "lazy";
      readerBody.append(image);
      continue;
    }
    const format = isFormat(block.format) ? block.format : "text";
    if (format === "md") {
      const rendered = document.createElement("div");
      rendered.className = "block-preview reader-md";
      rendered.innerHTML = renderMarkdown(block.text);
      readerBody.append(rendered);
      continue;
    }
    const node = document.createElement(
      format === "title" ? "h2" : format === "subtitle" ? "h3" : "p",
    );
    node.textContent = block.text;
    readerBody.append(node);
  }

  if (!readerBody.children.length) {
    const empty = document.createElement("p");
    empty.className = "reader-empty";
    empty.textContent = EMPTY_TEXT;
    readerBody.append(empty);
  }
}

function openMemo(memo, { editing = false } = {}) {
  currentId = memo.id;
  writerId = null;
  currentBlocks = memo.blocks;
  editorError.textContent = "";
  editorState.textContent = "";
  readerState.textContent = "";
  dirty = false;
  editor.hidden = false;
  document.body.classList.add("editing");
  renderReader(memo.title, memo.blocks);
  if (editing) startEditing();
  else setMode("read");
}

function startEditing() {
  editorError.textContent = "";
  setMode("write");
  if (writerId !== currentId) {
    titleInput.value = readerTitle.textContent;
    fillBlocks(currentBlocks);
    writerId = currentId;
  }
  setActiveRow(null);
}

/* 回阅读模式：用编辑框里的内容预览，没保存的改动还在编辑器里。 */
function finishEditing() {
  currentBlocks = collectBlocks();
  renderReader(titleInput.value.trim(), currentBlocks);
  readerState.textContent = dirty ? "未保存" : "";
  setActiveRow(null);
  setMode("read");
}

function closeEditor({ force = false } = {}) {
  if (!force && dirty && !window.confirm("还有没保存的改动，确定关掉吗？")) return;
  dirty = false;
  currentId = null;
  writerId = null;
  setActiveRow(null);
  editor.hidden = true;
  document.body.classList.remove("editing");
}

function markDirty() {
  dirty = true;
  editorState.textContent = "未保存";
}

function collectBlocks() {
  return [...blockArea.querySelectorAll(".block")].flatMap((row) => {
    if (row.dataset.type === "image") return [{ type: "image", url: row.dataset.url }];
    const text = row.querySelector("textarea").value.trim();
    if (!text) return [];
    return [{ type: "text", text, format: row.dataset.format || "text" }];
  });
}

async function saveMemo() {
  if (!currentId) return;
  editorError.textContent = "";
  editorState.textContent = "保存中…";
  try {
    const payload = await api(
      `/api/envelopes/${currentId}`,
      jsonOptions("PUT", { title: titleInput.value.trim(), blocks: collectBlocks() }),
    );
    const memo = payload.memo;
    memos = memos.map((item) => (item.id === memo.id ? memo : item));
    titleInput.value = memo.title;
    currentBlocks = memo.blocks;
    readerTitle.textContent = memo.title;
    readerState.textContent = "";
    writerId = memo.id;
    dirty = false;
    editorState.textContent = `已保存 · ${formatTime(memo.updatedAt)}`;
    renderGrid();
  } catch (error) {
    editorState.textContent = "";
    editorError.textContent = error.message;
  }
}

async function deleteMemo() {
  if (!currentId) return;
  const name = titleInput.value.trim() || readerTitle.textContent || "未命名信封";
  if (!window.confirm(`删除「${name}」？删掉就找不回来了。`)) return;
  try {
    await api(`/api/envelopes/${currentId}`, { method: "DELETE" });
    memos = memos.filter((item) => item.id !== currentId);
    closeEditor({ force: true });
    renderGrid();
  } catch (error) {
    editorError.textContent = error.message;
  }
}

/* ---------- 图片 ---------- */

async function shrinkImage(file) {
  if (file.size < 400 * 1024 || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    if (bitmap.close) bitmap.close();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

async function addImage(file) {
  if (!file) return;
  editorError.textContent = "";
  editorState.textContent = "上传图片中…";
  try {
    const blob = await shrinkImage(file);
    const payload = await api("/api/envelopes/image", {
      method: "POST",
      headers: { "Content-Type": blob.type || "image/jpeg" },
      body: blob,
    });
    blockArea.append(blockRow({ type: "image", url: payload.url }));
    markDirty();
    blockArea.lastElementChild.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch (error) {
    editorError.textContent = error.message;
  } finally {
    if (editorState.textContent === "上传图片中…") editorState.textContent = "";
    imageInput.value = "";
  }
}

/* ---------- 事件 ---------- */

document.getElementById("new-memo").addEventListener("click", createMemo);
document.getElementById("add-text").addEventListener("click", () => {
  addTextBlock();
  markDirty();
});
document.getElementById("add-image").addEventListener("click", () => imageInput.click());
document.getElementById("save-memo").addEventListener("click", saveMemo);
document.getElementById("delete-memo").addEventListener("click", deleteMemo);
document.getElementById("editor-close").addEventListener("click", () => closeEditor());
document.getElementById("edit-memo").addEventListener("click", startEditing);
document.getElementById("finish-memo").addEventListener("click", finishEditing);
for (const button of editor.querySelectorAll("[data-editor-close]")) {
  button.addEventListener("click", () => closeEditor());
}
titleInput.addEventListener("input", markDirty);
imageInput.addEventListener("change", () => addImage(imageInput.files[0]));

formatOptions.addEventListener("click", (event) => {
  const button = event.target.closest(".format-button");
  if (!button || !activeRow) return;
  applyFormat(activeRow, button.dataset.format);
  setActiveRow(activeRow);
  markDirty();
});

document.addEventListener("keydown", (event) => {
  if (editor.hidden) return;
  if (event.key === "Escape") {
    if (panel.dataset.mode === "write") finishEditing();
    else closeEditor();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (panel.dataset.mode === "write") saveMemo();
  }
});

loadMemos();
