// Single source of truth for HTTP endpoint paths shared across the boundary.
// Frontend imports these to build URLs; backend imports them to register routes.
// Pure data — no runtime dependencies.

/**
 * Build a path from a template by substituting :params.
 * @param {string} template
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function path(template, params = {}) {
  return template.replace(/:([a-zA-Z_]+)/g, (/** @type {string} */ _, /** @type {string} */ key) => {
    if (params[key] == null) throw new Error(`missing path param: ${key}`);
    return encodeURIComponent(String(params[key]));
  });
}

export const ROUTES = {
  health: "/health",

  comments: {
    list: "/api/comments", // GET ?page=
    create: "/api/comments", // POST
  },

  dashboards: {
    regimeSnapshots: "/api/dashboards/regime-snapshots", // GET ?range=
    researchSignal: "/api/dashboards/research-signals/:key", // GET
    vaultEconomics: "/api/dashboards/vault-economics", // GET
  },

  committee: {
    members: "/api/committee/members", // GET
    member: "/api/committee/members/:id", // GET
    subject: "/api/committee/subjects/:id", // GET
    subjectSnapshots: "/api/committee/subjects/:id/snapshots", // GET
    sessions: "/api/committee/sessions", // GET
    session: "/api/committee/sessions/:date/:subject", // GET
    brief: "/api/committee/brief", // GET ?date=&subject=
    apply: "/api/committee/apply", // POST
    submit: "/api/committee/submit", // POST
  },
};
