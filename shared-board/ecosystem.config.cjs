const fs = require("node:fs");
const path = require("node:path");

const projectDirectory = __dirname;

function readDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};

  const values = {};
  for (const sourceLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2].trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replace(/''/g, "'");
    }
    values[match[1]] = value;
  }
  return values;
}

const fileEnv = readDotEnv(path.join(projectDirectory, ".env"));

module.exports = {
  apps: [{
    name: "qe-star-bottle",
    cwd: projectDirectory,
    script: "server.js",
    exec_mode: "fork",
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: "512M",
    time: true,
    env: {
      NODE_ENV: process.env.NODE_ENV || fileEnv.NODE_ENV || "production",
      HOST: process.env.HOST || fileEnv.HOST || "127.0.0.1",
      PORT: process.env.PORT || fileEnv.PORT || "8787",
      BOARD_DATA_DIR: process.env.BOARD_DATA_DIR || fileEnv.BOARD_DATA_DIR || path.join(projectDirectory, "data"),
      OWNER_PASSWORD: process.env.OWNER_PASSWORD || fileEnv.OWNER_PASSWORD,
      SITE_USERNAME: process.env.SITE_USERNAME || fileEnv.SITE_USERNAME,
      SITE_PASSWORD: process.env.SITE_PASSWORD || fileEnv.SITE_PASSWORD,
      SESSION_HOURS: process.env.SESSION_HOURS || fileEnv.SESSION_HOURS || "12",
    },
  }],
};
