const form = document.querySelector("#site-login-form");
const username = document.querySelector("#site-username");
const password = document.querySelector("#site-password");
const button = document.querySelector("#site-login-button");
const status = document.querySelector("#site-login-status");

function returnTarget() {
  const rawTarget = new URLSearchParams(window.location.search).get("return") || "/home";
  try {
    const target = new URL(rawTarget, window.location.origin);
    if (
      target.origin !== window.location.origin ||
      !target.pathname.startsWith("/") ||
      target.pathname.startsWith("//") ||
      target.pathname.startsWith("/login")
    ) return "/home";
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return "/home";
  }
}

async function readResponse(response) {
  try { return await response.json(); } catch { return {}; }
}

async function redirectIfAuthenticated() {
  try {
    const response = await fetch("/api/site/status", { cache: "no-store", credentials: "same-origin" });
    const result = await readResponse(response);
    if (response.ok && result.authenticated === true) window.location.replace(returnTarget());
  } catch { /* The form remains usable when the status check fails. */ }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const account = username.value.trim();
  const secret = password.value;
  if (!account || !secret) {
    status.textContent = "请输入账号和密码";
    return;
  }
  button.disabled = true;
  status.textContent = "正在验证…";
  try {
    const response = await fetch("/api/site/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ username: account, password: secret }),
    });
    const result = await readResponse(response);
    if (!response.ok || result.authenticated !== true) {
      throw new Error(result.error || "账号或密码不正确");
    }
    window.location.replace(returnTarget());
  } catch (error) {
    status.textContent = error.message || "登录失败，请稍后再试";
    password.select();
  } finally {
    button.disabled = false;
  }
});

redirectIfAuthenticated();
