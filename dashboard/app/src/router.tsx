import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { AppShell } from './components/AppShell';
import { CurriculaPage } from './pages/CurriculaPage';
import { CurriculumPage, type CurriculumSearch } from './pages/CurriculumPage';
import { CurriculumRunPage } from './pages/CurriculumRunPage';
import { COMPARE_TABS, ComparePage, type CompareSearch, type CompareTab } from './pages/ComparePage';
import { DesignPage, type DesignSearch } from './pages/DesignPage';
import { HomePage } from './pages/HomePage';
import { SystemPage } from './pages/SystemPage';
import { InsightsPage, WEAKNESS_LAYERS, type InsightsSearch } from './pages/InsightsPage';
import type { WeaknessLayer } from './lib/api';
import { LAB_TABS, LabPage, type LabSearch, type LabTab } from './pages/LabPage';
import { ProposalPage } from './pages/ProposalPage';
import { ModelPage } from './pages/ModelPage';
import { MODEL_FILTERS, ModelsPage, type ModelFilter, type ModelsSearch } from './pages/ModelsPage';
import { RUN_TABS, RunPage, type RunTab } from './pages/RunPage';
import { LaunchPage, type LaunchSearch } from './pages/LaunchPage';
import { RunsPage, type RunsSearch } from './pages/RunsPage';

const root = createRootRoute({ component: AppShell });

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

const home = createRoute({ getParentRoute: () => root, path: '/', component: HomePage });
const runs = createRoute({
  getParentRoute: () => root,
  path: '/runs',
  component: RunsPage,
  validateSearch: (s: Record<string, unknown>): RunsSearch => ({
    view: str(s.view),
    type: str(s.type),
    q: str(s.q),
    sort: str(s.sort),
    page: typeof s.page === 'number' && s.page > 1 ? Math.floor(s.page) : undefined,
  }),
});
const launch = createRoute({
  getParentRoute: () => root,
  path: '/runs/new',
  component: LaunchPage,
  validateSearch: (s: Record<string, unknown>): LaunchSearch => ({ from: str(s.from), robot: str(s.robot) }),
});
const run = createRoute({
  getParentRoute: () => root,
  path: '/runs/$runId',
  component: RunPage,
  validateSearch: (s: Record<string, unknown>): { tab?: RunTab } => ({
    tab: RUN_TABS.includes(s.tab as RunTab) ? (s.tab as RunTab) : undefined,
  }),
});

const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v !== '' && isFinite(Number(v)) ? Number(v) : undefined);
/** Comma lists read back as arrays or numbers when they hold one id; keep them strings. */
const csv = (v: unknown) => (Array.isArray(v) ? v.join(',') : v != null && v !== '' ? String(v) : undefined);

const compare = createRoute({
  getParentRoute: () => root,
  path: '/compare',
  component: ComparePage,
  validateSearch: (s: Record<string, unknown>): CompareSearch => ({
    runs: csv(s.runs),
    models: csv(s.models),
    tab: COMPARE_TABS.includes(s.tab as CompareTab) ? (s.tab as CompareTab) : undefined,
    tags: s.tags != null ? csv(s.tags) ?? '' : undefined,
    smooth: num(s.smooth),
    x: s.x === 'time' ? 'time' : undefined,
    base: csv(s.base),
    metric: str(s.metric),
    stage: s.stage != null && s.stage !== '' ? String(s.stage) : undefined,
  }),
});

const models = createRoute({
  getParentRoute: () => root,
  path: '/models',
  component: ModelsPage,
  validateSearch: (s: Record<string, unknown>): ModelsSearch => ({
    view: s.view === 'leaderboard' ? 'leaderboard' : undefined,
    filter: MODEL_FILTERS.includes(s.filter as ModelFilter) && s.filter !== 'evaluated' ? (s.filter as ModelFilter) : undefined,
    q: str(s.q),
    sort: str(s.sort),
    page: typeof s.page === 'number' && s.page > 1 ? Math.floor(s.page) : undefined,
    run: csv(s.run),
    robot: str(s.robot),
    course: str(s.course),
    metric: str(s.metric),
    stage: s.stage != null && s.stage !== '' ? String(s.stage) : undefined,
    min: num(s.min) != null && num(s.min)! > 1 ? Math.floor(num(s.min)!) : undefined,
  }),
});
const model = createRoute({ getParentRoute: () => root, path: '/models/$modelId', component: ModelPage });

const curricula = createRoute({ getParentRoute: () => root, path: '/curricula', component: CurriculaPage });
const curriculum = createRoute({
  getParentRoute: () => root,
  path: '/curricula/$curriculumId',
  component: CurriculumPage,
  validateSearch: (s: Record<string, unknown>): CurriculumSearch => ({ robot: str(s.robot), from: str(s.from) }),
});
const curriculumRun = createRoute({ getParentRoute: () => root, path: '/curricula/runs/$runId', component: CurriculumRunPage });

const designSearch = (s: Record<string, unknown>): DesignSearch => ({ from: str(s.from), robot: str(s.robot) });
const design = createRoute({ getParentRoute: () => root, path: '/design', component: DesignPage, validateSearch: designSearch });
const designTab = createRoute({ getParentRoute: () => root, path: '/design/$tab', component: DesignPage, validateSearch: designSearch });
const designItem = createRoute({ getParentRoute: () => root, path: '/design/$tab/$itemId', component: DesignPage, validateSearch: designSearch });

const lab = createRoute({
  getParentRoute: () => root,
  path: '/lab',
  component: LabPage,
  validateSearch: (s: Record<string, unknown>): LabSearch => ({
    tab: LAB_TABS.includes(s.tab as LabTab) ? (s.tab as LabTab) : undefined,
    status: str(s.status),
    q: str(s.q),
    agent: str(s.agent),
    page: typeof s.page === 'number' && s.page > 1 ? Math.floor(s.page) : undefined,
  }),
});
const proposal = createRoute({
  getParentRoute: () => root,
  path: '/lab/$proposalId',
  component: ProposalPage,
  validateSearch: (s: Record<string, unknown>): { edit?: boolean } => ({ edit: s.edit === true || s.edit === 'true' ? true : undefined }),
});

const insights = createRoute({
  getParentRoute: () => root,
  path: '/insights',
  component: InsightsPage,
  validateSearch: (s: Record<string, unknown>): InsightsSearch => ({
    run: str(s.run),
    layer: WEAKNESS_LAYERS.some((l) => l.id === s.layer) ? (s.layer as WeaknessLayer) : undefined,
  }),
});

const system = createRoute({ getParentRoute: () => root, path: '/system', component: SystemPage });

const routeTree = root.addChildren([home, runs, launch, run, compare, models, model, curricula, curriculum, curriculumRun, design, designTab, designItem, lab, proposal, insights, system]);

export const router = createRouter({ routeTree, basepath: '/app' });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
