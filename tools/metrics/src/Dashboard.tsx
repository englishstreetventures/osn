import * as Plot from "@observablehq/plot";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@osn/ui/ui/card";
import { For, Show, type JSX } from "solid-js";

import { compactTokens } from "../../pr-metrics/format.ts";
import { cards } from "./cards.ts";
import { Chart, type ChartTheme } from "./Chart.tsx";
import {
  complexity,
  correctionRate,
  coverage,
  effortMix,
  type Mix,
  modelMix,
  monthly,
  type Monthly,
  sessionsAgainstCost,
  toRow,
} from "./shape.ts";

// The reference categorical palette's dark-surface steps, validated against
// the `--card` surface (#242424): every slot clears 3:1 and the worst adjacent
// pair holds ΔE 8.4 under protanopia. Hues are assigned to keys in the fixed
// order `Mix.keys` gives, never cycled, so a model keeps its colour across
// charts. Everything else a plot paints comes from the page tokens via
// `ChartTheme`, so this is the only colour the dashboard names itself.
const SERIES = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#9085e9"];

/**
 * Plot's `tip` mark draws its own box, and its default is a white card with a
 * `currentColor` border whatever the figure's background — the one light
 * surface left on the page once the figure itself is dark. Every mark with a
 * tip passes this instead of `tip: true`. Text stays `currentColor`, which is
 * the figure's ink.
 */
const tipStyle = (theme: ChartTheme) => ({ fill: theme.surface, stroke: theme.border });

const usd = (value: number): string => `$${value.toFixed(2)}`;
const pct = (value: number): string => `${(value * 100).toFixed(0)}%`;
const prLabel = (pr: number | null, branch: string): string =>
  pr === null ? branch : `#${pr} ${branch}`;

// ---------------------------------------------------------------------------
// Shared chart shapes
// ---------------------------------------------------------------------------

interface MonthlyChartProps {
  data: Monthly;
  label: string;
  format: (value: number) => string;
  tickFormat: string;
}

/**
 * One facet per month: a box (quartiles, whiskers, the median as a tick) with
 * every card as a dot beside it, so an outlier reads as one dot far from the
 * box rather than dragging a line. The median is also printed, because the
 * tick inside a box is easy to miss.
 */
function MonthlyChart(props: MonthlyChartProps) {
  return (
    <Chart
      options={(width, theme) => ({
        height: 300,
        marginLeft: 64,
        marginBottom: 40,
        fx: { label: "month", padding: 0.3 },
        x: { axis: null },
        y: { label: props.label, grid: theme.border, tickFormat: props.tickFormat, nice: true },
        marks: [
          Plot.boxY(props.data.points, {
            fx: "month",
            y: "value",
            // `--muted` is one step off the card surface, too close to read
            // as a box on the dark ground; a translucent ink fill is not.
            fill: theme.mutedInk,
            fillOpacity: 0.2,
            stroke: theme.mutedInk,
            r: 0,
          }),
          Plot.dot(
            props.data.points,
            Plot.dodgeX("middle", {
              fx: "month",
              y: "value",
              r: Math.max(3, Math.min(5, width / 200)),
              fill: SERIES[0],
              fillOpacity: 0.85,
              stroke: theme.surface,
              strokeWidth: 1,
              title: (d) => `${prLabel(d.pr, d.branch)}\n${props.format(d.value)}`,
              tip: tipStyle(theme),
            }),
          ),
          // Pinned to the top of the facet, not to the median's height, so it
          // never sits on top of the box it describes.
          Plot.text(props.data.medians, {
            fx: "month",
            text: (d) => `median ${props.format(d.median)} · ${d.prs} PRs`,
            frameAnchor: "top",
            dy: -6,
            fill: theme.ink,
          }),
        ],
      })}
    />
  );
}

interface MixChartProps {
  mix: Mix;
  label: string;
}

function MixChart(props: MixChartProps) {
  const color = () => ({
    domain: props.mix.keys,
    range: SERIES.slice(0, props.mix.keys.length),
    legend: true,
  });
  const months = () => [...new Set(props.mix.shares.map((share) => share.month))];

  return (
    <>
      <Chart
        options={(_width, theme) => ({
          height: 260,
          marginLeft: 48,
          // Ordinal on purpose: a month label is a bucket, not a date to
          // interpolate between, and Plot warns unless told so.
          x: { label: "month", padding: 0.4, type: "band" },
          y: { label: `share of ${props.label}`, tickFormat: ".0%", grid: theme.border },
          color: color(),
          marks: [
            Plot.barY(props.mix.shares, {
              x: "month",
              y: "share",
              fill: "key",
              // A surface-coloured gap between stacked segments, so adjacent
              // hues never touch.
              stroke: theme.surface,
              strokeWidth: 2,
              rx: 2,
              title: (d) => `${d.key}\n${pct(d.share)} · ${d.messages} messages`,
              tip: tipStyle(theme),
            }),
          ],
        })}
      />
      <div class="mt-3 overflow-x-auto">
        <table class="text-meta text-muted-foreground w-full">
          <thead>
            <tr class="text-subtle text-left">
              <th class="pr-3 font-normal">key</th>
              <For each={months()}>{(month) => <th class="pr-3 font-normal">{month}</th>}</For>
            </tr>
          </thead>
          <tbody>
            <For each={props.mix.keys}>
              {(key, i) => (
                <tr>
                  <td class="pr-3">
                    <span
                      class="mr-1.5 inline-block size-2.5 rounded-sm align-middle"
                      style={{ background: SERIES[i()] }}
                    />
                    {key}
                  </td>
                  <For each={months()}>
                    {(month) => {
                      const cell = props.mix.shares.find(
                        (share) => share.month === month && share.key === key,
                      );
                      return <td class="pr-3">{cell ? pct(cell.share) : "—"}</td>;
                    }}
                  </For>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------

interface SectionProps {
  title: string;
  question: string;
  note?: string;
  children: JSX.Element;
}

function Section(props: SectionProps) {
  return (
    <Card class="p-0">
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
        <CardDescription>{props.question}</CardDescription>
      </CardHeader>
      <CardContent>
        {props.children}
        <Show when={props.note}>
          <p class="text-meta text-subtle mt-3">{props.note}</p>
        </Show>
      </CardContent>
    </Card>
  );
}

function Empty(props: { children: JSX.Element }) {
  return (
    <div class="border-border text-body text-muted-foreground rounded-lg border border-dashed p-6 text-center">
      {props.children}
    </div>
  );
}

interface StatProps {
  value: string;
  label: string;
  detail: string;
  warn?: boolean;
}

function Stat(props: StatProps) {
  return (
    <div>
      <div class={`text-display font-semibold ${props.warn ? "text-destructive" : ""}`}>
        {props.value}
      </div>
      <div class="text-body font-medium">{props.label}</div>
      <div class="text-meta text-muted-foreground">{props.detail}</div>
    </div>
  );
}

export function Dashboard() {
  const cover = coverage(cards);
  // Merged pull requests only, by merge status — never by `phase`. The CLI
  // report draws the same line, for the reason `report.ts` gives: a remote
  // session's card stays `at-open` forever, so a phase filter would silently
  // keep only the work done on machines you still own.
  const rows = cards.map(toRow).filter((row) => row.mergedAt !== null);
  const mergedCards = cards.filter((card) => card.pr.merged_at !== null);

  const cost = monthly(rows, (row) => row.usd);
  const tokens = monthly(rows, (row) => row.totalTokens);
  const corrections = monthly(rows, correctionRate);
  const exploration = monthly(rows, (row) => row.exploreShare);
  const rated = complexity(rows);
  const sessions = sessionsAgainstCost(mergedCards);
  const models = modelMix(mergedCards);
  const effort = effortMix(mergedCards);

  const rangeLabel =
    cover.firstMonth === null
      ? "no cards"
      : cover.firstMonth === cover.lastMonth
        ? cover.firstMonth
        : `${cover.firstMonth} to ${cover.lastMonth}`;

  return (
    <div class="bg-background text-foreground min-h-full">
      <main class="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-8">
        <header class="mb-2">
          <h1 class="text-display font-semibold">Session metrics</h1>
          <p class="text-body text-muted-foreground mt-1">
            One card per pull request from <code>.claude/metrics/</code>, charted. Money is an
            API-equivalent at list rates, not a bill — this work runs on a subscription. Every
            distribution is summarised by its median. Read the coverage first.
          </p>
        </header>

        <section
          class="border-destructive/40 bg-destructive/5 rounded-xl border p-5"
          aria-label="Coverage"
        >
          <div class="text-meta text-destructive mb-3 font-medium tracking-wide uppercase">
            Coverage — how much of this can be trusted
          </div>
          <div class="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <Stat
              value={String(cover.cards)}
              label="cards"
              detail={`${cover.merged} merged · ${rangeLabel}`}
            />
            <Stat
              value={String(cover.confirmed)}
              label="with a confirmed complexity rating"
              detail={
                cover.unconfirmed > 0
                  ? `${cover.unconfirmed} more rated by an agent and unconfirmed — not charted`
                  : "cost against difficulty is empty until issues carry a complexity: label"
              }
              warn={cover.confirmed === 0}
            />
            <Stat
              value={cover.cards === 0 ? "—" : pct(cover.atOpen / cover.cards)}
              label="at-open"
              detail={`${cover.atMerge} at-merge · ${cover.atOpen} at-open. An at-open card cannot see review-cycle spend, so a corpus heavy with them under-reports.`}
            />
          </div>
        </section>

        <Section
          title="API-equivalent spend over time"
          question="Is a pull request getting cheaper or dearer, month by month?"
          note={`Box: quartiles and whiskers; dots: one per merged pull request. ${cost.points.length} of ${cover.cards} cards shown.`}
        >
          <Show when={cost.points.length > 0} fallback={<Empty>No merged cards yet.</Empty>}>
            <MonthlyChart
              data={cost}
              label="API-equivalent (USD) per PR"
              format={usd}
              tickFormat="$,.0f"
            />
          </Show>
        </Section>

        <Section
          title="Tokens over time"
          question="Same question in tokens, which do not move when a model's list price does."
          note="Total is output + cache reads + cache writes, the same definition as the CLI report."
        >
          <Show when={tokens.points.length > 0} fallback={<Empty>No merged cards yet.</Empty>}>
            <MonthlyChart
              data={tokens}
              label="tokens per PR"
              format={(value) => compactTokens(Math.round(value))}
              tickFormat="~s"
            />
          </Show>
        </Section>

        <Section
          title="Spend against declared complexity"
          question="Where does genuine waste separate from a hard problem?"
          note="Only confirmed ratings are charted. An unconfirmed rating is an agent's own guess about the difficulty of work it then did, and acting on it would make this circular."
        >
          <Show
            when={rated.points.length > 0}
            fallback={
              <Empty>
                <p class="font-medium">Nothing to chart: no card carries a confirmed rating.</p>
                <p class="mt-1">
                  {rated.unrated} of {rows.length} merged cards have no <code>complexity:</code>{" "}
                  label on their issue
                  {rated.unconfirmed > 0
                    ? `, and ${rated.unconfirmed} carry an unconfirmed rating that is excluded on purpose`
                    : ""}
                  . Ratings are set on the issue before work starts, by <code>/new-feat</code>{" "}
                  through the <code>rate-complexity</code> skill — this chart fills in as those
                  land.
                </p>
              </Empty>
            }
          >
            <Chart
              options={(_width, theme) => ({
                height: 320,
                marginLeft: 64,
                x: {
                  label: "declared complexity (Fibonacci, set before work)",
                  domain: [0.5, 8.5],
                  ticks: [1, 2, 3, 5, 8],
                  grid: theme.border,
                },
                y: {
                  label: "API-equivalent (USD)",
                  grid: theme.border,
                  tickFormat: "$,.0f",
                  nice: true,
                },
                marks: [
                  Plot.dot(rated.points, {
                    x: "declared",
                    y: "usd",
                    r: 5,
                    fill: SERIES[0],
                    fillOpacity: 0.85,
                    stroke: theme.surface,
                    title: (d) =>
                      `${prLabel(d.pr, d.branch)}\n${usd(d.usd)} · ${d.sourceLoc} source LOC`,
                    tip: tipStyle(theme),
                  }),
                ],
              })}
            />
          </Show>
        </Section>

        <Section
          title="Sessions per pull request against spend"
          question="Does a branch that needed more sessions cost more? (The strongest correlate so far.)"
          note="Dots: one per merged pull request. The line joins the median at each session count and is labelled with it."
        >
          <Show when={sessions.points.length > 0} fallback={<Empty>No merged cards yet.</Empty>}>
            <Chart
              options={(_width, theme) => ({
                height: 320,
                marginLeft: 64,
                x: {
                  label: "sessions on the branch",
                  ticks: sessions.medians.map((m) => m.sessions),
                  tickFormat: "d",
                  domain: [0.5, Math.max(...sessions.medians.map((m) => m.sessions)) + 0.5],
                  grid: theme.border,
                },
                y: {
                  label: "API-equivalent (USD)",
                  grid: theme.border,
                  tickFormat: "$,.0f",
                  nice: true,
                },
                marks: [
                  Plot.dot(sessions.points, {
                    x: "sessions",
                    y: "usd",
                    r: 4,
                    fill: SERIES[0],
                    fillOpacity: 0.7,
                    stroke: theme.surface,
                    title: (d) =>
                      `${prLabel(d.pr, d.branch)}\n${usd(d.usd)} · ${d.sessions} sessions`,
                    tip: tipStyle(theme),
                  }),
                  // The median line is ink, not a second hue: it is a summary
                  // of the dots, not another series.
                  Plot.lineY(sessions.medians, {
                    x: "sessions",
                    y: "median",
                    stroke: theme.ink,
                    strokeWidth: 2,
                    marker: "circle-stroke",
                  }),
                  Plot.text(sessions.medians, {
                    x: "sessions",
                    y: "median",
                    text: (d) => `${usd(d.median)} (n=${d.prs})`,
                    dy: -12,
                    fill: theme.ink,
                    stroke: theme.surface,
                    strokeWidth: 4,
                  }),
                ],
              })}
            />
          </Show>
        </Section>

        <Section
          title="Corrective-turn rate over time"
          question="Are briefs getting clearer? Corrections are human turns that arrived after the agent had started work."
          note={`Rate is corrections ÷ human turns per pull request. ${corrections.excluded} card(s) excluded: no human turn recorded, so the rate is unknown rather than zero.`}
        >
          <Show
            when={corrections.points.length > 0}
            fallback={<Empty>No merged card recorded a human turn.</Empty>}
          >
            <MonthlyChart
              data={corrections}
              label="corrective turns ÷ human turns"
              format={pct}
              tickFormat=".0%"
            />
          </Show>
        </Section>

        <Section
          title="Exploration share over time"
          question="How much of a pull request's spend went on finding the code before changing it?"
          note={`Share of tokens before the first observed edit. ${exploration.excluded} of ${rows.length} merged cards excluded: the transcript showed no edit, so the boundary is unknown — not 100%.`}
        >
          <Show
            when={exploration.points.length > 0}
            fallback={<Empty>No merged card has an observed first edit.</Empty>}
          >
            <MonthlyChart
              data={exploration}
              label="tokens before first edit ÷ total"
              format={pct}
              tickFormat=".0%"
            />
          </Show>
        </Section>

        <Section
          title="Model mix"
          question="Which model answered, as a share of assistant messages per month."
          note={`${models.unrecorded} card(s) recorded no model at all.`}
        >
          <Show when={models.shares.length > 0} fallback={<Empty>No merged cards yet.</Empty>}>
            <MixChart mix={models} label="assistant messages" />
          </Show>
        </Section>

        <Section
          title="Effort mix"
          question="Reasoning effort per assistant message. Flat today; this is the chart that will show a change working."
          note={`${effort.unrecorded} of ${mergedCards.length} merged cards carry no effort field on any message, so they are not in the bars.`}
        >
          <Show
            when={effort.shares.length > 0}
            fallback={<Empty>No merged card recorded an effort level.</Empty>}
          >
            <MixChart mix={effort} label="assistant messages" />
          </Show>
        </Section>
      </main>
    </div>
  );
}
