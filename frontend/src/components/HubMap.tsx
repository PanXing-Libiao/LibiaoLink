import { useCallback, useEffect, useRef, useState } from "react";
import { WORLD_MAP_COUNTRIES, WORLD_MAP_DASHLINE_PATHS, WORLD_MAP_MICRO_STATES, WORLD_MAP_NANHAI_ISLANDS, WORLD_MAP_VIEW, type WorldMapCountry, type WorldMapMicroState } from "../data/worldMap";
import { type HubMapDistribution, type HubMapPillar } from "../data/mapProjects";
import { projectStatusTextOf, textOf, useLocale, useLocalizedTranslator, useT, type Locale } from "../i18n";
import { buildListHash, EMPTY_LIST_QUERY } from "../useHashRoute";

/**
 * 蓝图页的平面世界地图（Push 188；Push 285 起本页由「入口页 / 首页」改名「蓝图」）。
 *
 * 底图 = 生成物 data/worldMap.ts（等距圆柱投影，生成脚本 scripts/generate-world-map.mjs）：
 * 世界国界取 Natural Earth 1:110m，**中国国界取中国标准地图口径**（含台湾、藏南、阿克赛钦、钓鱼岛，
 * 台湾并入中国的那条路径 —— 没有单独的「台湾」）；一个国家一条闭合路径，图上不写字、也不点参考图那种装饰性蓝点。
 * 鼠标触碰某国时该国提亮 + 浮起，并在面板左上角报出国名（动效口径见 app.css 的 .hub-map__country / .hub-map-badge）。
 * 南海断续线（十段）单独一层按线描出，不参与悬停。
 * 微国符号层（WORLD_MAP_MICRO_STATES）：110m 精度画不出的主权小国（新加坡、巴林、马耳他……）按形心画成小圆点，
 * 触碰同样提亮 + 报国名 —— 这是「逐国可辨认」的兜底，不是参考图那种装饰性蓝点。
 * 南海诸岛符号层（WORLD_MAP_NANHAI_ISLANDS）：视口里岛礁本体不足 1px，按中国标准地图的习惯点出来 —— **只点群岛**
 * （东沙 / 西沙 / 中沙 / 南沙 / 南沙南部·曾母暗沙一带 各一点，业务口径「细小的岛屿不用列」），触碰报「中国」—— 与台湾同一个口径。
 * 项目底色（Push 188 六追订「这个柱子重叠太严重了 还有没有别的方式来展示」→ 业务选定的「方案 E」；
 * 七追订「这个颜色深浅不能按照固定的数据来 到时候所有地区大于3个不就是同一个颜色了吗」→ 从写死的三档改成随数据自适应；
 * 再追订「这个数据要换吧 不能写的这么死 改成一档二档…」→ 图例只报**档位名**（一档 / 二档 / …，档数跟着数据走），
 * 具体几个项目挪到每一项的悬停说明里）：
 * 静止态一根立柱都不站，有项目的国家按项目数上蓝色底色 —— 档位边界由当前项目数分布自己算（buildTierBounds：
 * 把有项目的国家按项目数均分成最多 5 档，项目越多颜色越深），项目铺开后也不会「大于 N 个全一个色」。
 * 项目立柱层（Push 188 追订「地图要和项目地区联动，有立柱展示项目梳理」；六追订改成「触碰才出柱」）：
 * 鼠标触碰有项目的国家 / 微国时才长出一根柱 —— 高度 = 项目数、分段 = 项目状态；触碰立柱等同触碰该国
 * （国家同步提亮），左上角徽标加报项目数，右上角出「项目梳理」清单（项目名 + 类型色点 + 状态）；
 * 点立柱进「项目空间」并按该地区筛选；柱收起时不占命中（柱身、柱顶、命中区都不吃鼠标事件），不挡下面国家的触碰。
 * 九追订（业务改口「不要改成4s了 改成点击国家区域即可」）：点一下有项目的国家 / 微国 / 南海诸岛符号，
 * 就把它的立柱与右上角「项目梳理」钉住 —— 鼠标移开也不收回，腾出手去清单里滑动 / 展开；
 * 再点一次同一国、按 Esc、点海面空白处、或点清单上的「×」解除，点别国就把钉子挪过去（只碰不点不会钉）。
 * 聚合口径见 data/mapProjects.ts（联动键 = projects.region）。
 */
/** 微国符号半径（视口单位）：底图宽 1000，圆点只表示「这个国家在哪儿」，不代表疆域大小。 */
const MICRO_RADIUS = 2.4;
/** 命中半径：圆点视觉上很小，触碰要留容错区；命中层是透明的，hover 只改视觉层，免得命中区跟着变而抖动。 */
const MICRO_HIT_RADIUS = 4.4;

/** 南海诸岛符号半径（视口单位）：比微国符号小 —— 五个群岛各一个点，表示「这一片是中国的南海诸岛」。 */
const NANHAI_RADIUS = 1.4;
/** 南海诸岛符号的命中容错区：点位只有 1px 出头，不留容错区就点不中。 */
const NANHAI_HIT_RADIUS = 3.6;

/** 立柱几何（视口单位）：柱身半宽 / 命中半宽 / 柱顶椭圆压扁的比例 / 清单最多列几条。 */
const PILLAR_BODY_HALF = 3.6;
const PILLAR_HIT_HALF = 7;
const PILLAR_TOP_RY = 1.3;
/** 命中区上下留白：上留 12（柱顶数字也算命中区），下留 8（免得柱脚盖住微国圆点，圆点还要能单独触碰） */
const PILLAR_TOP_PAD = 12;
const PILLAR_BOTTOM_GAP = 8;
/** 微国立柱的柱脚抬高量：柱子站在圆点上沿，别把圆点整颗盖住 */
const PILLAR_MICRO_BASE_OFFSET = 3.2;
const PILLAR_MAX_ROWS = 6;
/** 九追订（业务改口：「不要改成4s了 改成点击国家区域即可」，再追「点击空白区域也可以取消定住」）：
 *  点一下有项目的国家 / 微国就把它钉住 —— 立柱与右上角「项目梳理」不再跟着鼠标走，鼠标可以去清单里滑动 / 展开；
 *  再点一次同一国、按 Esc、点海面空白处、或点清单上的「×」解除，点别国就把钉子挪过去。 */

/** 静止态底色的档位上限：色阶在 app.css 里备了 5 档（[data-tier="1"]..[data-tier="5"]，由浅到深）。
 *  这里没有写死的「1 / 2 / 3 个及以上」天花板 —— 档位边界按当前数据算，将来项目铺开了也不会「大于 N 个全一个色」。 */
const TIER_MAX = 5;

/** 图例里「档位怎么算的」口径说明：鼠标停在「项目数」或分档提示上给看（与 buildTierBounds 同一套算法；文案在词典 hm.tierRule，中英随界面语言）。 */

/** 项目数 → 档位边界（数据自适应）：把所有有项目的国家按项目数升序排，每档尽量装一样多的国家
 *  （累计到「地区数 / 档数」就切下一档），同项目数的国家必在同一档；最多 TIER_MAX 档。
 *  例：1 个的 20 国 + 2 个的 17 国 + 3 个的 4 国 + 5 个的 1 国 → [1, 2, 5]（三档：「1 个」/「2 个」/「3 个及以上」）。 */
function buildTierBounds(totals: readonly number[]): number[] {
  if (totals.length === 0) {
    return [];
  }
  const counted = new Map<number, number>();
  for (const total of totals) {
    counted.set(total, (counted.get(total) ?? 0) + 1);
  }
  const values = [...counted.keys()].sort((a, b) => a - b);
  const max = values[values.length - 1];
  const scale = Math.min(TIER_MAX, Math.max(1, Math.ceil(Math.log2(max + 1))), values.length);
  const perTier = totals.length / scale;
  const bounds: number[] = [];
  let acc = 0;
  for (let index = 0; index < values.length; index += 1) {
    acc += counted.get(values[index]) ?? 0;
    if (bounds.length < scale - 1 && acc >= perTier && index < values.length - 1) {
      bounds.push(values[index]);
      acc = 0;
    }
  }
  if (bounds[bounds.length - 1] !== max) {
    bounds.push(max);
  }
  return bounds;
}

/** 项目数 → 底色档位序号（1..n）；0 个项目的国家不上蓝（data-tier="0"，保持灰底那一套）。 */
function tierIndex(total: number, bounds: readonly number[]): number {
  for (let index = 0; index < bounds.length; index += 1) {
    if (total <= bounds[index]) {
      return index + 1;
    }
  }
  return bounds.length;
}

/** 档位序号（1..n）→ 色阶槽位（1..TIER_MAX）：档数少于色阶档数时把色阶「拉开」用，
 *  最深那一档永远取最深的槽位（例：三档 → 槽位 1 / 3 / 5），免得「最高的档」看着还是浅蓝。 */
function tierSlot(index: number, count: number): number {
  if (count <= 1) {
    return Math.ceil(TIER_MAX / 2);
  }
  return Math.round(1 + ((index - 1) * (TIER_MAX - 1)) / (count - 1));
}

/** 档位文案：单值档报「N 个项目」，最高档报「N 个及以上」，中间多值档报「a–b 个项目」。 */
function tierText(locale: Locale, index: number, bounds: readonly number[]): string {
  const upper = bounds[index];
  const lower = index === 0 ? 1 : bounds[index - 1] + 1;
  if (lower === upper) {
    return textOf(locale, "hm.nProjects", { n: upper });
  }
  return index === bounds.length - 1 ? textOf(locale, "hm.nPlus", { n: lower }) : textOf(locale, "hm.nRange", { a: lower, b: upper });
}

/** 档位名（图例里显示的就是这个）：一档 / 二档 / …，最多 TIER_MAX 档 —— 只报「第几档」，
 *  具体几个项目放在悬停说明里（范围跟着数据变，写进图例看着就像写死的口径）。 */
const TIER_NAME_KEYS = ["hm.tier1", "hm.tier2", "hm.tier3", "hm.tier4", "hm.tier5"] as const;
function tierName(locale: Locale, index: number): string {
  const key = TIER_NAME_KEYS[index];
  return key === undefined ? textOf(locale, "hm.tierN", { n: index + 1 }) : textOf(locale, key);
}

/** 触碰时要报国名的目标：国家路径、微国符号、南海诸岛符号，字段口径一致（nameZh + name）。 */
type HoveredLabel = WorldMapCountry | WorldMapMicroState;
/** 南海诸岛符号报的国名：直接取国界层里中国那条记录，不另造「南海诸岛」这种实体词条。 */
const CHINA_LABEL: HoveredLabel = WORLD_MAP_COUNTRIES.find((country) => country.name === "China") ?? { id: "156", name: "China", nameZh: "中国", d: "" };

/** 立柱 key → 底图实体（立柱与国界层同键，触碰立柱时要能回填同一个国名对象）。 */
const LABEL_BY_KEY = new Map<string, HoveredLabel>();
for (const country of WORLD_MAP_COUNTRIES) {
  LABEL_BY_KEY.set(country.id, country);
}
for (const state of WORLD_MAP_MICRO_STATES) {
  LABEL_BY_KEY.set(state.id, state);
}

export function HubMap({ distribution, note = "" }: { distribution: HubMapDistribution | null; note?: string }) {
  const locale = useLocale();
  const t = useT();
  const localize = useLocalizedTranslator();
  const [hovered, setHovered] = useState<HoveredLabel | null>(null);
  // 九追订：点了国家区域之后钉住的那根柱（"" = 没钉）；钉住后清单可滑动 / 展开
  const [pinnedKey, setPinnedKey] = useState("");
  const [expanded, setExpanded] = useState(false);
  // 淡出期间保留上一次的国名，免得徽标一边淡出一边空掉
  const lastHovered = useRef<HoveredLabel | null>(null);
  if (hovered !== null) {
    lastHovered.current = hovered;
  }

  const pillars = distribution === null ? [] : distribution.pillars;
  const pillarByKey = new Map<string, HubMapPillar>();
  for (const pillar of pillars) {
    pillarByKey.set(pillar.key, pillar);
  }
  const hoveredKey = hovered === null ? "" : hovered.id;
  // 显隐只看当前是否真的悬停（shown 是给淡出保留内容的），否则悬停过一次就再也不收起
  const hoveredPillar = hovered === null ? null : pillarByKey.get(hovered.id) ?? null;
  // 九追订：钉住之后鼠标可以走开 —— 立柱、国名徽标、项目清单都跟着「钉住的那根」走；没钉时才跟着悬停
  const pinnedPillar = pinnedKey === "" ? null : pillarByKey.get(pinnedKey) ?? null;
  const pinnedLabel = pinnedKey === "" ? null : LABEL_BY_KEY.get(pinnedKey) ?? null;
  const activePillar = pinnedPillar ?? hoveredPillar;
  const shown = hovered ?? pinnedLabel ?? lastHovered.current;
  const shownPillar = activePillar ?? (shown === null ? null : pillarByKey.get(shown.id) ?? null);
  /** 联动 / 高亮看这个 key：钉住时钉住的那国保持高亮，免得鼠标一走开就掉色 */
  const linkedKey = pinnedPillar === null ? hoveredKey : pinnedKey;
  // 有项目的国家（含微国）：整块国土按项目数上蓝底 + 深蓝轮廓（档位边界随数据算，见 buildTierBounds）；
  // 没有项目的国家不上蓝（data-tier="0"，仍是灰底那一套）
  const tierBounds = buildTierBounds(pillars.map((pillar) => pillar.total));
  const tierByKey = new Map<string, string>();
  for (const pillar of pillars) {
    tierByKey.set(pillar.key, String(tierSlot(tierIndex(pillar.total, tierBounds), tierBounds.length)));
  }
  const statuses = distribution === null ? [] : distribution.statuses;
  const unmatched = distribution === null ? [] : distribution.unmatched;

  const unpin = useCallback(() => {
    setPinnedKey("");
    setExpanded(false);
  }, []);

  /** 九追订：点国家区域 = 钉住 / 再点一次解除（点别国就把钉子挪过去）。 */
  const togglePin = useCallback((key: string) => {
    setPinnedKey((current) => (current === key ? "" : key));
    setExpanded(false);
  }, []);

  // 钉住时 Esc 解除（清单上的「×」是同一个动作）
  useEffect(() => {
    if (pinnedKey === "") {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        unpin();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pinnedKey, unpin]);

  const hoverIn = (label: HoveredLabel) => setHovered(label);
  const hoverOut = (key: string) => setHovered((current) => (current !== null && current.id === key ? null : current));
  /** 九追订：只有有项目的国家 / 微国点了才钉（没项目的国家点了不响应，别造出一个空钉子）。 */
  const pinByKey = (key: string) => {
    if (pillarByKey.has(key)) {
      togglePin(key);
    }
  };

  return (
    <>
      <svg
        className="hub-map"
        viewBox={"0 0 " + WORLD_MAP_VIEW.width + " " + WORLD_MAP_VIEW.height}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={t("hm.mapAria")}
        onMouseLeave={() => setHovered(null)}
        onClick={(event) => {
          /* 九追订：「点击空白区域也可以取消定住」—— 事件目标就是 svg 自己时说明点在海面 / 图外空白上
             （点国家 / 微国 / 立柱时目标是那些子元素，不会走到这儿），这时把钉子取消。 */
          if (event.target === event.currentTarget) {
            unpin();
          }
        }}
      >
        {WORLD_MAP_COUNTRIES.map((country) => (
          <path
            key={country.name}
            className="hub-map__country"
            data-country={country.nameZh}
            data-linked={linkedKey === country.id ? "true" : "false"}
            data-tier={tierByKey.get(country.id) ?? "0"}
            d={country.d}
            onMouseEnter={() => hoverIn(country)}
            onMouseLeave={() => hoverOut(country.id)}
            onClick={() => pinByKey(country.id)}
          />
        ))}
        <g className="hub-map__dashline">
          {WORLD_MAP_DASHLINE_PATHS.map((d, index) => (
            <path key={index} d={d} />
          ))}
        </g>
        {/* 南海诸岛：只点群岛（五个代表点），按标准地图习惯点出来；触碰报「中国」 */}
        <g className="hub-map__nanhai-layer">
          {WORLD_MAP_NANHAI_ISLANDS.map((island, index) => (
            <g
              key={index}
              className="hub-map__nanhai"
              data-country={CHINA_LABEL.nameZh}
              data-linked={linkedKey === CHINA_LABEL.id ? "true" : "false"}
              onMouseEnter={() => hoverIn(CHINA_LABEL)}
              onMouseLeave={() => hoverOut(CHINA_LABEL.id)}
              onClick={() => pinByKey(CHINA_LABEL.id)}
            >
              <circle className="hub-map__nanhai-hit" cx={island.x} cy={island.y} r={NANHAI_HIT_RADIUS} />
              <circle className="hub-map__nanhai-island" cx={island.x} cy={island.y} r={NANHAI_RADIUS} />
            </g>
          ))}
        </g>
        <g className="hub-map__micro-layer">
          {WORLD_MAP_MICRO_STATES.map((state) => (
            <g
              key={state.name}
              className="hub-map__micro"
              data-country={state.nameZh}
              data-linked={linkedKey === state.id ? "true" : "false"}
              data-tier={tierByKey.get(state.id) ?? "0"}
              onMouseEnter={() => hoverIn(state)}
              onMouseLeave={() => hoverOut(state.id)}
              onClick={() => pinByKey(state.id)}
            >
              <circle className="hub-map__micro-hit" cx={state.x} cy={state.y} r={MICRO_HIT_RADIUS} />
              <circle className="hub-map__micro-dot" cx={state.x} cy={state.y} r={MICRO_RADIUS} />
            </g>
          ))}
        </g>
        {/* 项目立柱：高度 = 项目数，分段 = 项目状态；触碰立柱等同触碰该国，点柱进「项目空间」按该地区筛选 */}
        <g className="hub-map__pillar-layer">
          {pillars.map((pillar) => {
            const baseY = pillar.kind === "micro" ? pillar.y - PILLAR_MICRO_BASE_OFFSET : pillar.y;
            const top = baseY - pillar.height;
            let stacked = 0;
            return (
              <g
                key={pillar.key}
                className="hub-map__pillar"
                data-pillar={pillar.nameZh}
                data-kind={pillar.kind}
                data-count={pillar.total}
                data-height={pillar.height}
                data-x={Math.round(pillar.x * 10) / 10}
                data-y={Math.round(pillar.y * 10) / 10}
                data-linked={linkedKey === pillar.key ? "true" : "false"}
                data-shown={linkedKey === pillar.key ? "true" : "false"}
                data-pinned={pinnedKey === pillar.key ? "true" : "false"}
                data-top-status={pillar.segments.at(-1)?.status ?? ""}
                onMouseEnter={() => {
                  const label = LABEL_BY_KEY.get(pillar.key);
                  if (label !== undefined) {
                    hoverIn(label);
                  }
                }}
                onMouseLeave={() => hoverOut(pillar.key)}
                onClick={() => { window.location.hash = buildListHash({ ...EMPTY_LIST_QUERY, regions: pillar.regions.slice() }); }}
              >
                <rect className="hub-map__pillar-hit" x={pillar.x - PILLAR_HIT_HALF} y={top - PILLAR_TOP_PAD} width={PILLAR_HIT_HALF * 2} height={pillar.height + PILLAR_TOP_PAD - PILLAR_BOTTOM_GAP} />
                <g className="hub-map__pillar-body" style={{ transformOrigin: pillar.x + "px " + baseY + "px" }}>
                  {pillar.segments.map((segment) => {
                    const height = (pillar.height * segment.count) / pillar.total;
                    const y = baseY - stacked - height;
                    stacked += height;
                    return <rect key={segment.status} className="hub-map__pillar-seg" data-status={segment.status} x={pillar.x - PILLAR_BODY_HALF} y={y} width={PILLAR_BODY_HALF * 2} height={height} />;
                  })}
                  <ellipse className="hub-map__pillar-top" cx={pillar.x} cy={top} rx={PILLAR_BODY_HALF} ry={PILLAR_TOP_RY} />
                </g>
                <text className="hub-map__pillar-count" x={pillar.x} y={top - 4}>{pillar.total}</text>
              </g>
            );
          })}
        </g>
      </svg>
      <div className="hub-map-badge" data-active={hovered === null && pinnedKey === "" ? "false" : "true"} data-pinned={pinnedPillar === null ? "false" : "true"} aria-hidden="true">
        <span className="hub-map-badge__zh">{shown === null ? "" : shown.nameZh}</span>
        <span className="hub-map-badge__en">{shown === null ? "" : shown.name}</span>
        {shownPillar === null ? null : <span className="hub-map-badge__count">{t("hm.nProjects", { n: shownPillar.total })}</span>}
        {pinnedPillar === null ? null : <span className="hub-map-badge__pin">{t("hm.pinned")}</span>}
      </div>
      {/* 项目梳理：触碰有项目的国家 / 立柱时，右上角列出该国的项目（类型色点 + 状态） */}
      <div
        className="hub-map-projects"
        data-active={activePillar === null ? "false" : "true"}
        data-pinned={pinnedPillar === null ? "false" : "true"}
        data-expanded={expanded ? "true" : "false"}
        data-country={shownPillar === null ? "" : shownPillar.nameZh}
        aria-hidden={pinnedPillar === null ? "true" : undefined}
      >
        <div className="hub-map-projects__head">
          <span className="hub-map-projects__zh">{shownPillar === null ? "" : locale === "en" ? shownPillar.name : shownPillar.nameZh}</span>
          <span className="hub-map-projects__total">{shownPillar === null ? "" : t("hm.total", { n: shownPillar.total })}</span>
          {pinnedPillar === null ? null : (
            <span className="hub-map-projects__tools">
              <button type="button" className="hub-map-projects__expand" onClick={() => setExpanded((value) => !value)}>{expanded ? t("hm.collapse") : t("hm.expandAll")}</button>
              <button type="button" className="hub-map-projects__close" onClick={unpin} aria-label={t("hm.unpinAria")}>×</button>
            </span>
          )}
        </div>
        <ul className="hub-map-projects__list">
          {activePillar === null
            ? null
            : (pinnedPillar === null ? activePillar.projects.slice(0, PILLAR_MAX_ROWS) : activePillar.projects).map((project) => (
                <li key={project.id} data-live-card={project.id} className="hub-map-projects__row">
                  <span className="hub-map-projects__dot" style={{ background: project.accent }} />
                  <span className="hub-map-projects__name" title={locale === "en" ? project.name : undefined}>{localize(project.name)}</span>
                  <span className="hub-map-projects__status">{projectStatusTextOf(locale, project.status)}</span>
                </li>
              ))}
        </ul>
        {shownPillar === null || shownPillar.projects.length <= PILLAR_MAX_ROWS ? null : pinnedPillar === null ? (
          <div className="hub-map-projects__more">{t("hm.more", { n: shownPillar.projects.length - PILLAR_MAX_ROWS })}</div>
        ) : (
          <div className="hub-map-projects__more">{t("hm.pinnedSummary", { n: shownPillar.projects.length, state: expanded ? t("hm.expandedAll") : t("hm.scrollable") })}</div>
        )}
      </div>
      {/* 图例与脚注：底色档位（一档 / 二档 …，档数与每档范围都随数据算）+ 立柱分段色 + 总量；对不上国家的地区单列 */}
      <div className="hub-map-legend" data-active={distribution !== null || note !== "" ? "true" : "false"} aria-hidden="true">
        <span className="hub-map-legend__group">
          <span className="hub-map-legend__gloss" title={t("hm.tierRule")}>{t("hm.legendCount")}</span>
          {tierBounds.map((bound, index) => (
            <span key={bound} className="hub-map-legend__item" title={tierName(locale, index) + (locale === "en" ? ": " : "：") + tierText(locale, index, tierBounds)}>
              <span className="hub-map-legend__swatch" data-tier={String(tierSlot(index + 1, tierBounds.length))} />
              {tierName(locale, index)}
            </span>
          ))}
          <span className="hub-map-legend__hint" title={t("hm.tierRule")}>{t("hm.autoTiers", { n: tierBounds.length })}</span>
        </span>
        <span className="hub-map-legend__group">
          <span className="hub-map-legend__gloss">{t("hm.legendSegment")}</span>
          {statuses.map((status) => (
            <span key={status} className="hub-map-legend__item">
              <span className="hub-map-legend__swatch" data-status={status} />
              {projectStatusTextOf(locale, status)}
            </span>
          ))}
        </span>
        {distribution === null ? null : (
          <span className="hub-map-legend__total">{t("hm.coverage", { n: distribution.totalProjects, m: distribution.pillars.length })}</span>
        )}
        {unmatched.length === 0 ? null : (
          <span className="hub-map-legend__unmatched">{t("hm.unmatched") + unmatched.map((item) => t("hm.unmatchedItem", { region: item.region, n: item.count })).join(" / ")}</span>
        )}
        {note === "" ? null : <span className="hub-map-legend__note">{note}</span>}
      </div>
    </>
  );
}
