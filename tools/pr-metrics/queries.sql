-- Session-metrics queries. Run with DuckDB from the repository root:
--
--   duckdb -init tools/pr-metrics/queries.sql
--
-- The committed cards are the datalake. There is no service to run: DuckDB
-- reads .claude/metrics/*.json where they sit, git supplies the versioning, and
-- nothing here has a free-tier cap to watch.
--
-- Median, never mean, for any per-pull-request distribution. These are
-- severely right-skewed: across the first 34 cards the median was 3.6M tokens,
-- the mean 15.4M and the maximum 92.7M, so a mean describes the three largest
-- pull requests and invents month-over-month growth that is not there.
--
-- Full schema and the reasoning behind it: wiki/conventions/session-metrics.md

-- `map_inference_threshold` reads an object with more than 20 distinct keys
-- across the cards as a MAP rather than a STRUCT. `tool_calls` is one: a card
-- can name both `Bash` and `bash`, and struct fields are case-insensitive, so
-- inferring a struct fails on a duplicate name.
CREATE OR REPLACE VIEW cards AS
  SELECT * FROM read_json_auto('.claude/metrics/*.json', union_by_name := true,
                               map_inference_threshold := 20);

-- Merged pull requests. Filtered on merge status, deliberately NOT on
-- `phase = 'at-merge'`: a remote session's container is destroyed when it ends,
-- taking its transcripts with it, so remotely-produced cards can never be
-- refreshed past `at-open`. Filtering on phase would silently drop every pull
-- request that was not worked on a machine you still own — which biases every
-- analysis below toward local work while looking like it is simply being
-- careful. `phase` stays a visible column instead; query 7 reports the split.
CREATE OR REPLACE VIEW merged AS
  SELECT * FROM cards WHERE pr.merged_at IS NOT NULL;

-- Ratios everything below shares. Kept as a view rather than stored on the
-- card: a definition that lives in one file can be changed and re-run over
-- history, and a stored ratio cannot.
CREATE OR REPLACE VIEW metrics AS
  SELECT
    pr.number                                       AS pr,
    pr.branch                                       AS branch,
    pr.generated_at::TIMESTAMP                      AS at_ts,
    complexity.declared                             AS declared,
    complexity.method                               AS rating_method,
    pr.phase                                        AS phase,
    spend.usd_equivalent                            AS usd,
    diff.loc.source.added + diff.loc.source.deleted AS source_loc,
    diff.files.source                               AS source_files,
    interaction.user_turns                          AS turns,
    interaction.corrective_turns                    AS corrections,
    "window".active_seconds                           AS active_s,
    spend.tokens.output
      + spend.tokens.cache_read
      + spend.tokens.cache_write_5m
      + spend.tokens.cache_write_1h                 AS total_tokens,
    spend.tokens.cache_read
      / nullif(spend.tokens.output + spend.tokens.cache_read
               + spend.tokens.cache_write_5m + spend.tokens.cache_write_1h, 0) AS cache_read_share,
    -- NULL when the transcript showed no edit: the boundary is unknown, not
    -- zero and certainly not 100%. Counting those as pure exploration sorted
    -- this ranking by which branches avoided the Edit tool.
    interaction.tokens_before_first_edit
      / nullif(spend.tokens.output + spend.tokens.cache_read
               + spend.tokens.cache_write_5m + spend.tokens.cache_write_1h, 0) AS explore_share,
    interaction.sessions_with_observed_edit                                    AS edited_sessions,
    spend.by_actor.subagent.usd_equivalent
      / nullif(spend.usd_equivalent, 0)             AS subagent_share
  FROM merged;

--------------------------------------------------------------------------------
-- 1. Where agents cost too much for the job
--------------------------------------------------------------------------------
-- The query this whole system exists for. A small, low-rated task that cost a
-- lot is either a missing skill or an unclear brief — the next two queries say
-- which. Unconfirmed ratings are excluded: acting on an agent's unreviewed
-- guess about how hard something was is the one thing that would make this
-- circular.

SELECT pr, declared, source_loc, round(usd, 2) AS usd, turns, corrections
FROM metrics
WHERE declared <= 2 AND source_loc < 100 AND rating_method = 'confirmed'
ORDER BY usd DESC
LIMIT 20;

--------------------------------------------------------------------------------
-- 2. Which areas need a skill or a wiki page
--------------------------------------------------------------------------------
-- `explore_share` is what the agent spent working out where the code lives
-- before changing any of it. High and repeated in one package means that
-- package has no usable map, and the fix is a wiki page or a skill — not a
-- cheaper model.

SELECT package, count(*) AS prs, round(median(explore_share) * 100, 1) AS explore_pct
FROM (SELECT pr.number AS pr, unnest(diff.packages) AS package FROM merged) AS touched
JOIN metrics USING (pr)
WHERE explore_share IS NOT NULL
GROUP BY package
HAVING count(*) >= 3
ORDER BY explore_pct DESC;

--------------------------------------------------------------------------------
-- 3. Are briefs getting clearer?
--------------------------------------------------------------------------------
-- `corrections` counts turns that arrived after the agent had already started
-- work. This is the one number here that measures the person rather than the
-- model: one turn and a large spend is a clear brief; nine turns is a brief
-- that needed nine patches.

SELECT date_trunc('month', at_ts) AS month,
       count(*)                AS prs,
       round(median(turns), 1)    AS median_turns,
       round(median(corrections), 1) AS median_corrections
FROM metrics
GROUP BY month
ORDER BY month;

--------------------------------------------------------------------------------
-- 4. Is the context surface bloating?
--------------------------------------------------------------------------------
-- Cache reads are the agent re-reading the same context. A share that climbs
-- month over month means CLAUDE.md, the skills and the wiki pages an agent
-- opens are growing faster than the work is.

SELECT date_trunc('month', at_ts) AS month,
       round(median(cache_read_share) * 100, 1) AS cache_read_pct,
       round(median(total_tokens) / 1e6, 1)     AS median_mtok
FROM metrics
GROUP BY month
ORDER BY month;

--------------------------------------------------------------------------------
-- 5. Cost per unit of declared difficulty
--------------------------------------------------------------------------------
-- The headline ratio. Read it as a trend, never as a target: driving it down
-- by rating everything an 8 is trivial, and the rating is set before the work
-- precisely so that cannot happen quietly.

SELECT declared,
       count(*)                     AS prs,
       round(median(usd), 2)           AS median_usd,
       round(median(usd) / declared, 2) AS usd_per_point,
       round(median(active_s) / 60)    AS median_active_min
FROM metrics
WHERE rating_method = 'confirmed'
GROUP BY declared
ORDER BY declared;

--------------------------------------------------------------------------------
-- 6. Is delegation paying off?
--------------------------------------------------------------------------------
-- Subagent share against cost at the same declared difficulty. If the heavily
-- delegated PRs are not cheaper at equal difficulty, the delegation is
-- re-reading context rather than saving it.

SELECT declared,
       round(median(subagent_share) * 100) AS subagent_pct,
       round(median(usd), 2)               AS median_usd,
       count(*)                         AS prs
FROM metrics
WHERE rating_method = 'confirmed'
GROUP BY declared
ORDER BY declared;

--------------------------------------------------------------------------------
-- 7. Coverage — how much of the history can actually be trusted
--------------------------------------------------------------------------------
-- Run this before believing any of the above. A confirmed-rating count in the
-- single digits means every trend above is noise. The phase split matters just
-- as much: an `at-open` card is missing its review-cycle cost, and every card
-- produced by a remote session stays `at-open` forever, so a corpus that is
-- mostly `at-open` under-reports the true cost of the work it describes.

SELECT rating_method, phase, count(*) AS prs, round(sum(usd), 2) AS total_usd
FROM metrics
GROUP BY rating_method, phase
ORDER BY prs DESC;

--------------------------------------------------------------------------------
-- 8. Model calls and the context each carried
--------------------------------------------------------------------------------
-- Cost is calls times context, since each call re-reads the context. Every
-- card, merged or not: most cards with the field are still at-open. These two
-- queries read the raw JSON, because cards written before the fields existed
-- give `read_json_auto` nothing to infer a struct from. `--split-at` has no SQL
-- form: it asks git when a commit landed (`report.ts`).

CREATE OR REPLACE VIEW raw AS
  SELECT json FROM read_json_objects('.claude/metrics/*.json');

SELECT substr(coalesce(json_extract_string(json, '$.pr.merged_at'), json_extract_string(json, '$.pr.generated_at')), 1, 7) AS month,
       count(*) AS prs,
       median((json_extract_string(json, '$.interaction.requests.main'))::INT
              + (json_extract_string(json, '$.interaction.requests.subagent'))::INT) AS median_calls,
       round(median((json_extract_string(json, '$.interaction.requests.with_one_tool'))::DOUBLE
              / nullif((json_extract_string(json, '$.interaction.requests.with_tools'))::DOUBLE, 0)) * 100) AS single_tool_pct,
       median((json_extract_string(json, '$.interaction.requests.context_median'))::BIGINT) AS median_context
FROM raw
WHERE json_extract_string(json, '$.interaction.requests') IS NOT NULL
GROUP BY month
ORDER BY month;

--------------------------------------------------------------------------------
-- 9. Review findings that led to a change
--------------------------------------------------------------------------------
-- Tests and docs findings only. Paired findings acted on after the review —
-- the cited line changed, or, for a tests finding, a test importing its file
-- landed — against control lines 35 away. By line leaves out the findings a
-- landed test counted, so it is counted as the control is: compare by line,
-- not acted on, with the control. A block with no by-test count has none to
-- leave out. prep-pr fixes every in-scope finding, so this measures what got
-- changed, not how good the findings were.

SELECT count(*) AS prs,
       sum((json_extract_string(json, '$.review.located'))::INT) AS located,
       sum((json_extract_string(json, '$.review.paired'))::INT) AS paired,
       round(sum((json_extract_string(json, '$.review.acted_on_paired'))::INT) * 100.0
             / nullif(sum((json_extract_string(json, '$.review.paired'))::INT), 0)) AS acted_on_pct,
       round(sum((json_extract_string(json, '$.review.acted_on_paired'))::INT
                 - coalesce((json_extract_string(json, '$.review.acted_on_paired_by_test'))::INT, 0)) * 100.0
             / nullif(sum((json_extract_string(json, '$.review.paired'))::INT), 0)) AS by_line_pct,
       round(sum((json_extract_string(json, '$.review.control_changed'))::INT) * 100.0
             / nullif(sum((json_extract_string(json, '$.review.paired'))::INT), 0)) AS control_pct
FROM raw
WHERE json_extract_string(json, '$.review') IS NOT NULL AND json_extract_string(json, '$.review') <> 'null';
