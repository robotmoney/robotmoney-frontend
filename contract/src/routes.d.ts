export function path(template: string, params?: Record<string, string | number>): string;

export const ROUTES: {
  health: string;
  comments: { list: string; create: string };
  dashboards: {
    regimeSnapshots: string;
    researchSignal: string;
    vaultEconomics: string;
  };
  projects: {
    list: string;
  };
  committee: {
    members: string;
    member: string;
    subject: string;
    subjectSnapshots: string;
    sessions: string;
    session: string;
    brief: string;
    apply: string;
    submit: string;
  };
};
