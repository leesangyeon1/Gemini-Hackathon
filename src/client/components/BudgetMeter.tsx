import React from 'react';
import type { BudgetSnapshot, PublicRuntimeConfig } from '../../shared/types';

export interface BudgetMeterProps {
  config: PublicRuntimeConfig | null;
  budget: BudgetSnapshot | null;
  sessionId: string | null;
  isExpanding: boolean;
  useSyntheticDemo: boolean;
  onExpandSession: () => void;
}

export const BudgetMeter: React.FC<BudgetMeterProps> = ({
  config,
  budget,
  sessionId,
  isExpanding,
  useSyntheticDemo,
  onExpandSession,
}) => {
  const globalMonthlyLimit = budget?.globalMonthlyLimit ?? config?.budgetLimits.globalMonthlyLimit ?? 35;
  const globalRemaining = budget?.globalRemaining ?? globalMonthlyLimit;
  const sessionAvmsUsed = budget?.sessionAvmsUsed ?? 0;
  const sessionAvmsLimit =
    budget?.sessionAvmsLimit ?? config?.budgetLimits.defaultSessionAvmsLimit ?? 5;
  const sessionListingsUsed = budget?.sessionListingsUsed ?? 0;
  const sessionListingsLimit =
    budget?.sessionListingsLimit ?? config?.budgetLimits.defaultSessionListingsLimit ?? 1;
  const sessionExpanded = budget?.sessionExpanded ?? false;
  const durabilityMode = budget?.durabilityMode ?? config?.budgetLimits.durabilityMode ?? 'sqlite';
  const quotaExhausted = budget?.quotaExhausted ?? false;

  const canExpand =
    Boolean(sessionId) &&
    !sessionExpanded &&
    globalRemaining > 0 &&
    !useSyntheticDemo;

  return (
    <section
      className={`budget-meter ${quotaExhausted ? 'budget-meter-exhausted' : ''}`}
      aria-label="RentCast Session & Global Budget Meter"
      data-testid="budget-meter"
    >
      <div className="budget-header">
        <div>
          <h2 className="panel-title-sm">RentCast API Budget Guard</h2>
          <p className="muted-xs">
            Durable store: <code>{durabilityMode}</code> · Zero calls on map pan, zoom, or marker hover
          </p>
        </div>
        {useSyntheticDemo && <span className="pill pill-demo">DEMO · 0 LIVE CALLS</span>}
      </div>

      <div className="budget-metrics">
        <div className="metric-box">
          <span className="metric-label">Session AVMs</span>
          <strong className="metric-value" data-testid="session-avms-meter">
            {sessionAvmsUsed} / {sessionAvmsLimit}
          </strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Session Searches</span>
          <strong className="metric-value">
            {sessionListingsUsed} / {sessionListingsLimit}
          </strong>
        </div>
        <div className="metric-box">
          <span className="metric-label">Global Monthly Remaining</span>
          <strong className="metric-value" data-testid="global-remaining-meter">
            {globalRemaining} / {globalMonthlyLimit}
          </strong>
        </div>
      </div>

      {sessionExpanded ? (
        <p className="muted-xs status-good">
          Session expanded: up to {sessionAvmsLimit} on-demand home AVMs enabled for this session.
        </p>
      ) : (
        <div className="budget-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={!canExpand || isExpanding}
            onClick={onExpandSession}
          >
            {isExpanding ? 'Expanding Session…' : 'Expand Session Limit (up to 10 AVMs)'}
          </button>
          {!sessionId && (
            <span className="muted-xs">Run Analyze Area first to initialize a tracked session.</span>
          )}
        </div>
      )}
    </section>
  );
};
