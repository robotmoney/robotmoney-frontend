export function path(template: string, params?: Record<string, string | number>): string;

export const ROUTES: {
  health: string;
  comments: { list: string; create: string };
  dashboards: {
    regimeSnapshots: string;
    researchSignal: string;
    vaultEconomics: string;
    walletBalances: string;
    buybacks: string;
    tokenMetrics: string;
    walletSleeves: string;
    allocation: string;
  };
  projects: {
    list: string;
    adminUpdate: string;
  };
  committee: {
    members: string;
    member: string;
    subject: string;
    subjectSnapshots: string;
    sessions: string;
    session: string;
    openSession: string;
    brief: string;
    signingPayload: string;
    memos: string;
    memo: string;
    verifyToken: string;
    apply: string;
    register: string;
    regime: string;
    submit: string;
    admin: {
      action: string;
      activate: string;
      reset: string;
      regime: string;
      subject: string;
      subjectFixtures: string;
      open: string;
      brief: string;
      close: string;
      aggregate: string;
      publish: string;
      enqueueJob: string;
    };
  };
  analytics: {
    rawHistory: string;
    rawHistorySeed: string;
    regimeSnapshots: string;
    researchSignals: string;
  };
  admin: {
    auth: string;
    jobs: string;
    job: string;
    runs: string;
  };
};
