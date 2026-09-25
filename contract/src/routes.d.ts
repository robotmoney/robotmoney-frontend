export function path(template: string, params?: Record<string, string | number>): string;

export const ROUTES: {
  health: string;
  version: string;
  apiVersion: string;
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
    entities: string;
    overview: string;
    list2: string;
    leaderboard: string;
    submissions: string;
    activity: string;
    agents: string;
    agentDetail: string;
    coins: string;
    vaults: string;
    wallets: string;
    coinDetail: string;
    vaultDetail: string;
    walletDetail: string;
  };
  projects: {
    list: string;
    detail: string;
    adminUpdate: string;
  };
  swarm: {
    members: string;
    waitlist: string;
    member: string;
    memberTakes: string;
    memberJudgements: string;
    memberProfile: string;
    memberAvatar: string;
    subject: string;
    subjectSnapshots: string;
    sessions: string;
    session: string;
    sessionById: string;
    sessionConsensusReceipt: string;
    sessionConsensusReceiptVerified: string;
    sessionJudgements: string;
    take: string;
    takePermalink: string;
    judgement: string;
    openSession: string;
    brief: string;
    signingPayload: string;
    memos: string;
    memo: string;
    verifyToken: string;
    apply: string;
    applyStatus: string;
    applicationStatus: string;
    claimChallenge: string;
    claimToken: string;
    register: string;
    regime: string;
    submit: string;
    scheduler: {
      fullRead: string;
      subscribe: string;
    };
    participants: {
      pending: string;
      judgeSubscribe: string;
      judgement: string;
    };
    admin: {
      action: string;
      activate: string;
      /** `reset` removed — it wiped published session history (see routes.js). */
      regime: string;
      subject: string;
      subjectFixtures: string;
      open: string;
      brief: string;
      close: string;
      aggregate: string;
      publish: string;
      enqueueJob: string;
      subjects: string;
      subjectUpdate: string;
      subjectDeactivate: string;
      subjectActivate: string;
      epochOpen: string;
      epochTurnover: string;
      epochAggregate: string;
      epochRequestJudging: string;
      epochFinalize: string;
      members: string;
      applications: string;
      memberReview: string;
      memberUpdate: string;
      memberDeactivate: string;
      memberReactivate: string;
      memberRotateKey: string;
      memberRole: string;
      memberAvatar: string;
      sessionRoster: string;
      sessionJudgements: string;
      rosterAdd: string;
      rosterExcuse: string;
      rosterRestore: string;
      judgeConfig: string;
      sessionConsensusReceipt: string;
      audit: string;
    };
  };
  analytics: {
    readiness: string;
    rawHistory: string;
    sourceAcquisitions: string;
    rawHistorySeed: string;
    researchSignalDates: string;
    rawHistoryGaps: string;
    researchEligibility: string;
    telemetry: string;
    runs: string;
    runEvents: string;
    vintages: string;
    vintage: string;
    runPackage: string;
    reportSnapshot: string;
    paritySweep: string;
  };
  admin: {
    auth: string;
    isClaimed: string;
    claim: string;
    overview: string;
    gaps: string;
    jobs: string;
    job: string;
    jobRetry: string;
    runs: string;
    schedule: string;
    audit: string;
    researchRuns: string;
    researchRun: string;
    researchRawSeries: string;
    researchSignal: string;
    researchRerun: string;
  };
};

/** One item of `GET ROUTES.swarm.participants.pending` (smoke-production-spec.md §6.2). */
export interface ParticipantPendingWork {
  sessionId: string;
  subjectId: string;
  date: string;
  windowClosesAt: string | null;
}

/** The pending route's body: a list, empty when there is no work — never null. */
export interface ParticipantPendingResponse {
  pending: ParticipantPendingWork[];
}

/**
 * The spend of the model call behind a judgement, as the participant measured
 * it (D55 decision 3, R19). Every field optional; an absent field is stored as
 * NULL, never 0. Token counts are whole and non-negative; costUsd is
 * non-negative. Not covered by the judgement's signature.
 */
export interface ParticipantJudgementUsage {
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  costUsd?: number | null;
}

/** `POST ROUTES.swarm.participants.judgement` body, signed over `canonicalizeJudgement`. */
export interface ParticipantJudgementBody {
  sessionId: string;
  /** The model's raw answer text; the API parses it. */
  opinion: string;
  model: string;
  promptHash: string;
  inputsDigest: string;
  nonce: string;
  signature: string;
  usage?: ParticipantJudgementUsage;
}
