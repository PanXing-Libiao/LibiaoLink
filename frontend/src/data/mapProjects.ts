/**
 * 项目 × 地图联动（Push 188 追订）。
 *
 * 业务口径（2026-09-24）：「这个地图做好是要和我的项目地区联动的 哪个项目做哪个地区
 * 然后地图这个国家就保持鼠标悬停的效果 然后有立柱展示项目梳理」。
 *
 * 口径（改规则只改这里）：
 * - 联动键 = `projects.region`（字典 region 的码；条目由业务自建，实测就是国家名：中国 / 美国 / 英国 / 新加坡……）。
 * - 落点 = 国家路径 / 微国符号的锚点：国家取「最大子路径」的包围盒中心，若该点不在国界内，
 *   就在同一包围盒里按网格采样、取「在国界内且离中心最近」的点（凹形状也站得住）；微国取生成物里的形心点位。
 * - 对不上国家的地区（例如「华东」「海外」）→ 计入「未落到图上」，只报数、不画立柱，面板脚注里列出。
 * - 立柱高度 = 项目数（0.6 次幂折算，18 ~ 92 视口单位，且顶不过锚点上方 8 个单位，免得顶出画布）；
 *   立柱分段 = 项目状态（active / paused / done / archived），段高按条数占比分。
 */
import { WORLD_MAP_COUNTRIES, WORLD_MAP_MICRO_STATES, type WorldMapCountry, type WorldMapMicroState } from "./worldMap";
import { accentOfItem, dictLabel, type Dicts } from "../dicts";
import { PROJECT_STATUS_TEXT, PROJECT_STATUS_VALUES, type ProjectStatusValue } from "../types";
import type { ProjectMapOverviewItem } from "../projectApi";

/** 项目状态（契约 projects.status）：取值与文案收敛到 types.ts 的单一来源（Push 262 —— 卡片状态字 / 编辑弹窗 / 地图图例同口径）。 */
export type MapProjectStatus = ProjectStatusValue;

/** 状态展示顺序与文案（立柱分段、图例、项目清单、卡片状态字、编辑弹窗共用一套口径）。 */
export const MAP_PROJECT_STATUS_ORDER: readonly MapProjectStatus[] = PROJECT_STATUS_VALUES;
export const MAP_PROJECT_STATUS_TEXT: Record<MapProjectStatus, string> = PROJECT_STATUS_TEXT;

export type MapProjectStatusCount = { readonly status: MapProjectStatus; readonly count: number };

/** 立柱上挂的一个项目（给「项目梳理」清单用）。 */
export type MapProjectItem = {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: MapProjectStatus;
  readonly statusText: string;
  readonly projectType: string;
  readonly projectTypeName: string;
  readonly accent: string;
  /** 当前账号对该项目的最终访问级别；null = 仅展示概况，不能进入详情。 */
  readonly accessLevel: "edit" | "view" | null;
};

/** 一根立柱：一个国家（或微国）上的项目分布。 */
export type HubMapPillar = {
  /** 与国家路径 / 微国符号同键：国家用国界层 id，微国用微国层 id。 */
  readonly key: string;
  readonly kind: "country" | "micro";
  readonly name: string;
  readonly nameZh: string;
  /** 锚点（视口单位）即立柱的落点。 */
  readonly x: number;
  readonly y: number;
  readonly total: number;
  readonly segments: readonly MapProjectStatusCount[];
  readonly projects: readonly MapProjectItem[];
  /** 立柱高度（视口单位），已按锚点位置截过顶。 */
  readonly height: number;
  /** 这根柱对应的地区字典码（点柱跳「项目空间」按地区筛选要用）。 */
  readonly regions: readonly string[];
};

/** 地区对不上国家：只计数，脚注里列出来（业务自己决定要不要把条目改成国家名）。 */
export type MapUnmatchedRegion = { readonly region: string; readonly count: number };

export type HubMapDistribution = {
  readonly pillars: readonly HubMapPillar[];
  readonly unmatched: readonly MapUnmatchedRegion[];
  /** 全部未删项目数（含对不上国家的）。 */
  readonly totalProjects: number;
  /** 落到图上的项目数。 */
  readonly placedProjects: number;
  /** 图上出现过的状态（图例只列出现过的）。 */
  readonly statuses: readonly MapProjectStatus[];
};

const PILLAR_MIN_HEIGHT = 18;
const PILLAR_MAX_HEIGHT = 92;
const PILLAR_TOP_MARGIN = 8;

/** 契约外的状态一律按 archived 计（图上不会凭空冒出一个状态）。 */
function toStatus(value: string): MapProjectStatus {
  return value === "active" || value === "paused" || value === "done" ? value : "archived";
}

type Ring = { readonly points: readonly number[]; readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };

/** 底图 d 里按「M」切子路径（海外岛屿 / 跨经线切片都是子路径），每段解析成点表 + 包围盒。 */
function parseRings(d: string): Ring[] {
  const rings: Ring[] = [];
  for (const sub of d.split("M")) {
    const numbers = sub.match(/-?[0-9.]+/g);
    if (numbers === null || numbers.length < 8) {
      continue;
    }
    const points: number[] = [];
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let index = 0; index + 1 < numbers.length; index += 2) {
      const x = Number(numbers[index]);
      const y = Number(numbers[index + 1]);
      points.push(x, y);
      if (x < minX) { minX = x; }
      if (y < minY) { minY = y; }
      if (x > maxX) { maxX = x; }
      if (y > maxY) { maxY = y; }
    }
    rings.push({ points: points, minX: minX, minY: minY, maxX: maxX, maxY: maxY });
  }
  return rings;
}

/** 射线法判点是否在多边形里：纯计算、不依赖浏览器（生成物是视口坐标的直多边形，没有洞）。 */
function pointInRing(points: readonly number[], x: number, y: number): boolean {
  let inside = false;
  const count = Math.floor(points.length / 2);
  for (let i = 0, k = count - 1; i < count; k = i, i += 1) {
    const xi = points[i * 2];
    const yi = points[i * 2 + 1];
    const xk = points[k * 2];
    const yk = points[k * 2 + 1];
    if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function insideCountry(rings: readonly Ring[], x: number, y: number): boolean {
  for (const ring of rings) {
    if (pointInRing(ring.points, x, y)) {
      return true;
    }
  }
  return false;
}

const anchorCache = new Map<string, { readonly x: number; readonly y: number } | null>();

/** 国家锚点：最大子路径的包围盒中心；不在国界内就按 7 × 7 网格采样，取内点里离中心最近的那个（每国只算一次，缓存）。 */
export function countryAnchor(country: WorldMapCountry): { readonly x: number; readonly y: number } | null {
  const cached = anchorCache.get(country.name);
  if (cached !== undefined) {
    return cached;
  }
  const rings = parseRings(country.d);
  let host: Ring | null = null;
  for (const ring of rings) {
    if (host === null || (ring.maxX - ring.minX) * (ring.maxY - ring.minY) > (host.maxX - host.minX) * (host.maxY - host.minY)) {
      host = ring;
    }
  }
  let anchor: { x: number; y: number } | null = null;
  if (host !== null) {
    const centerX = (host.minX + host.maxX) / 2;
    const centerY = (host.minY + host.maxY) / 2;
    if (insideCountry(rings, centerX, centerY)) {
      anchor = { x: centerX, y: centerY };
    } else {
      let bestDistance = Infinity;
      for (let row = 1; row < 8; row += 1) {
        for (let column = 1; column < 8; column += 1) {
          const x = host.minX + ((host.maxX - host.minX) * column) / 8;
          const y = host.minY + ((host.maxY - host.minY) * row) / 8;
          if (!insideCountry(rings, x, y)) {
            continue;
          }
          const distance = (x - centerX) * (x - centerX) + (y - centerY) * (y - centerY);
          if (distance < bestDistance) {
            bestDistance = distance;
            anchor = { x: x, y: y };
          }
        }
      }
      if (anchor === null) {
        anchor = { x: centerX, y: centerY };
      }
    }
  }
  anchorCache.set(country.name, anchor);
  return anchor;
}

type GeoMatch = { readonly kind: "country"; readonly country: WorldMapCountry } | { readonly kind: "micro"; readonly micro: WorldMapMicroState };

/** 地区名 → 国家：先精确对中文名 / 英文名，再宽松对（只有唯一命中才算，避免「刚果」这种歧义）。 */
export function matchRegion(name: string, code: string): GeoMatch | null {
  const wanted = name.trim() === "" ? code.trim() : name.trim();
  for (const country of WORLD_MAP_COUNTRIES) {
    if (country.nameZh === wanted || country.name === wanted) {
      return { kind: "country", country: country };
    }
  }
  for (const micro of WORLD_MAP_MICRO_STATES) {
    if (micro.nameZh === wanted || micro.name === wanted) {
      return { kind: "micro", micro: micro };
    }
  }
  let hit: GeoMatch | null = null;
  let hits = 0;
  for (const country of WORLD_MAP_COUNTRIES) {
    if (country.nameZh.length >= 2 && (wanted.includes(country.nameZh) || country.nameZh.includes(wanted))) {
      hit = { kind: "country", country: country };
      hits += 1;
    }
  }
  for (const micro of WORLD_MAP_MICRO_STATES) {
    if (micro.nameZh.length >= 2 && (wanted.includes(micro.nameZh) || micro.nameZh.includes(wanted))) {
      hit = { kind: "micro", micro: micro };
      hits += 1;
    }
  }
  return hits === 1 ? hit : null;
}

/** 立柱高度：项目数折算成 18 ~ 92 视口单位（0.6 次幂，条数差得大也不至于顶破画布）。 */
export function pillarHeight(total: number, maxTotal: number): number {
  if (total <= 0) {
    return 0;
  }
  if (maxTotal <= 1) {
    return PILLAR_MIN_HEIGHT;
  }
  const ratio = Math.pow(total / maxTotal, 0.6);
  return Math.round((PILLAR_MIN_HEIGHT + (PILLAR_MAX_HEIGHT - PILLAR_MIN_HEIGHT) * ratio) * 10) / 10;
}

type Bucket = {
  readonly kind: "country" | "micro";
  readonly key: string;
  readonly name: string;
  readonly nameZh: string;
  readonly x: number;
  readonly y: number;
  readonly projects: ProjectMapOverviewItem[];
  readonly regions: string[];
};

/** 项目清单 → 立柱（按国聚合）。锚点取不到的国家记入「未落到图上」。 */
export function buildMapDistribution(projects: readonly ProjectMapOverviewItem[], dicts: Dicts): HubMapDistribution {
  const byRegion = new Map<string, ProjectMapOverviewItem[]>();
  for (const project of projects) {
    const list = byRegion.get(project.region);
    if (list === undefined) {
      byRegion.set(project.region, [project]);
    } else {
      list.push(project);
    }
  }
  const buckets = new Map<string, Bucket>();
  const unmatched: MapUnmatchedRegion[] = [];
  for (const [code, list] of byRegion) {
    const label = dictLabel(dicts, "region", code);
    const match = matchRegion(label, code);
    const anchor = match === null ? null : match.kind === "country" ? countryAnchor(match.country) : { x: match.micro.x, y: match.micro.y };
    if (match === null || anchor === null) {
      unmatched.push({ region: label, count: list.length });
      continue;
    }
    const key = match.kind === "country" ? match.country.id : match.micro.id;
    const name = match.kind === "country" ? match.country.name : match.micro.name;
    const nameZh = match.kind === "country" ? match.country.nameZh : match.micro.nameZh;
    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, { kind: match.kind, key: key, name: name, nameZh: nameZh, x: anchor.x, y: anchor.y, projects: list.slice(), regions: [code] });
    } else {
      for (const project of list) {
        existing.projects.push(project);
      }
      existing.regions.push(code);
    }
  }
  let maxTotal = 0;
  for (const bucket of buckets.values()) {
    if (bucket.projects.length > maxTotal) {
      maxTotal = bucket.projects.length;
    }
  }
  const seen = new Set<MapProjectStatus>();
  const pillars: HubMapPillar[] = [];
  for (const bucket of buckets.values()) {
    const segments: MapProjectStatusCount[] = [];
    for (const status of MAP_PROJECT_STATUS_ORDER) {
      const count = bucket.projects.filter((project) => toStatus(project.status) === status).length;
      if (count > 0) {
        segments.push({ status: status, count: count });
        seen.add(status);
      }
    }
    const items: MapProjectItem[] = bucket.projects.map((project) => {
      const status = toStatus(project.status);
      const accent = accentOfItem(dicts.projectType.find((entry) => entry.code === project.projectType));
      return {
        id: project.id,
        code: project.code,
        name: project.name,
        status: status,
        statusText: MAP_PROJECT_STATUS_TEXT[status],
        projectType: project.projectType,
        projectTypeName: dictLabel(dicts, "projectType", project.projectType),
        accent: accent.color,
        accessLevel: project.accessLevel,
      };
    });
    items.sort((a, b) => MAP_PROJECT_STATUS_ORDER.indexOf(a.status) - MAP_PROJECT_STATUS_ORDER.indexOf(b.status) || (a.name < b.name ? -1 : 1));
    const total = items.length;
    const room = bucket.y - PILLAR_TOP_MARGIN;
    const height = Math.min(pillarHeight(total, maxTotal), Math.max(PILLAR_MIN_HEIGHT, room));
    pillars.push({ key: bucket.key, kind: bucket.kind, name: bucket.name, nameZh: bucket.nameZh, x: bucket.x, y: bucket.y, total: total, segments: segments, projects: items, height: height, regions: bucket.regions });
  }
  pillars.sort((a, b) => b.total - a.total || (a.nameZh < b.nameZh ? -1 : 1));
  let placedProjects = 0;
  for (const pillar of pillars) {
    placedProjects += pillar.total;
  }
  unmatched.sort((a, b) => b.count - a.count || (a.region < b.region ? -1 : 1));
  return {
    pillars: pillars,
    unmatched: unmatched,
    totalProjects: projects.length,
    placedProjects: placedProjects,
    statuses: MAP_PROJECT_STATUS_ORDER.filter((status) => seen.has(status)),
  };
}

