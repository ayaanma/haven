// Single source of truth for who owns which files. Used by scripts/check-ownership.mjs,
// eslint.config.js (import boundaries), and AGENTS.md. Foundation owns everything not
// listed under an agent. Changing this file is a foundation change.

/** @type {Record<string, { title: string; paths: string[] }>} */
export const AGENTS = {
  agent1: {
    title: "Agent 1: G2 SOS workflow, HUD, onboarding, API client",
    paths: [
      "apps/g2/src/main.ts",
      "apps/g2/src/hud/**",
      "apps/g2/src/workflows/**",
      "apps/g2/src/onboarding/**",
      "apps/g2/src/services/**",
    ],
  },
  agent2: {
    title: "Agent 2: alerts, Photon 2.0 messaging, contacts, webhooks",
    paths: [
      "apps/api/src/alerts/**",
      "apps/api/src/photon/**",
      "apps/api/src/contacts/**",
      "apps/api/src/routes/alerts.ts",
      "apps/api/src/routes/contacts.ts",
      "apps/api/src/routes/photon-webhooks.ts",
    ],
  },
  agent3: {
    title: "Agent 3: G2 sensors (location, IMU) and AI emergency context",
    paths: ["apps/g2/src/devices/**", "apps/api/src/context/**"],
  },
  agent4: {
    title: "Agent 4: emergency audio capture, upload, storage, and sharing",
    paths: ["apps/g2/src/audio/**", "apps/api/src/audio/**", "apps/api/src/routes/audio.ts"],
  },
};

export const FOUNDATION = "foundation";

/** Minimal glob → RegExp: `**` spans directories, `*` stays within one segment. */
export function globToRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (char === "*") {
      source += "[^/]*";
    } else {
      source += char.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

const compiled = Object.entries(AGENTS).map(([agent, { paths }]) => ({
  agent,
  patterns: paths.map(globToRegExp),
}));

/** Owner of a repo-relative path (forward slashes). */
export function ownerOf(file) {
  const normalized = file.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const { agent, patterns } of compiled) {
    if (patterns.some((p) => p.test(normalized))) return agent;
  }
  return FOUNDATION;
}
