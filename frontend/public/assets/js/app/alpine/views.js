// Alpine.data factories for the data-driven views. They fetch the API through
// app/lib/api.js (HTTP-only boundary) and expose plain state the HTML renders
// with x-for/x-text. No build, no Web Components.
//
// Split one-module-per-factory (review-maintainability finding 025: this file
// was a 12-view, 1350-line hot-file collision magnet). Each views/* module
// exports a register<View>(Alpine) function and registers exactly ONE factory;
// shared regime-chart helpers live in views/shared.js. This barrel keeps
// main.js's boot import (`import { registerViews } from "./alpine/views.js"`)
// unchanged — factories must still be registered at boot, before Alpine
// processes the DOM, because views inject via innerHTML.
import { registerProjectsView } from "./views/projects.js";
import { registerRegimeView } from "./views/regime.js";
import { registerResearchView } from "./views/research.js";
import { registerWalletPerfView } from "./views/wallet-perf.js";
import { registerFeeChart } from "./views/fee-chart.js";
import { registerBlogCharts } from "./views/blog-charts.js";
import { registerBuybackSummary } from "./views/buyback-summary.js";
import { registerAllocationView } from "./views/allocation.js";
import { registerCommitteeView } from "./views/committee.js";
import { registerCommentsThread } from "./views/comments.js";
import { registerApplyForm } from "./views/apply-form.js";
import { registerAdminSurfaceView } from "./views/admin-surface.js";
import { registerAdminCommitteeOverview } from "./views/admin/committee-overview.js";
import { registerAdminCommitteeSubject } from "./views/admin/committee-subject.js";
import { registerAdminCommitteeMember } from "./views/admin/committee-member.js";
import { registerAdminCommitteeSession } from "./views/admin/committee-session.js";
import { registerDashStyleguideView } from "./views/dash-styleguide.js";
import { registerDashShellView } from "./views/dash-shell.js";
import { registerListView } from "./views/list.js";
import { registerList2View } from "./views/list2.js";
import { registerList3View } from "./views/list3.js";
import { registerSubmitView } from "./views/submit.js";
import { registerActivityView } from "./views/activity.js";
import { registerAgentsView } from "./views/dash-agents.js";
import { registerAgentProfileView } from "./views/dash-agent-profile.js";
import { registerDashLobsterView } from "./views/dash-lobster.js";
import { registerDashVaultsView } from "./views/dash-vaults.js";
import { registerDashWalletsView } from "./views/dash-wallets.js";
import { registerAskRobotoView } from "./views/dash-ask-roboto.js";
import { registerProjectProfileView } from "./views/dash-project-profile.js";

export function registerViews(Alpine) {
  registerProjectsView(Alpine);
  registerRegimeView(Alpine);
  registerResearchView(Alpine);
  registerWalletPerfView(Alpine);
  registerFeeChart(Alpine);
  registerBlogCharts(Alpine);
  registerBuybackSummary(Alpine);
  registerAllocationView(Alpine);
  registerCommitteeView(Alpine);
  registerCommentsThread(Alpine);
  registerApplyForm(Alpine);
  registerAdminSurfaceView(Alpine);
  registerAdminCommitteeOverview(Alpine);
  registerAdminCommitteeSubject(Alpine);
  registerAdminCommitteeMember(Alpine);
  registerAdminCommitteeSession(Alpine);
  registerDashStyleguideView(Alpine);
  registerDashShellView(Alpine);
  registerListView(Alpine);
  registerList2View(Alpine);
  registerList3View(Alpine);
  registerSubmitView(Alpine);
  registerActivityView(Alpine);
  registerAgentsView(Alpine);
  registerAgentProfileView(Alpine);
  registerDashLobsterView(Alpine);
  registerDashVaultsView(Alpine);
  registerDashWalletsView(Alpine);
  registerAskRobotoView(Alpine);
  registerProjectProfileView(Alpine);
}
