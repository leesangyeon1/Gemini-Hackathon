import React from 'react';
import type { PublicRuntimeConfig } from '../../shared/types';

export interface SetupAndDemoBannerProps {
  config: PublicRuntimeConfig | null;
  configLoading: boolean;
  configError: string | null;
  useSyntheticDemo: boolean;
  onToggleSyntheticDemo: (enabled: boolean) => void;
  onRetryConfig: () => void;
}

export const SetupAndDemoBanner: React.FC<SetupAndDemoBannerProps> = ({
  config,
  configLoading,
  configError,
  useSyntheticDemo,
  onToggleSyntheticDemo,
  onRetryConfig,
}) => {
  if (configLoading) {
    return (
      <section className="banner banner-info" aria-live="polite" aria-busy="true">
        <span>Loading runtime capability configuration…</span>
      </section>
    );
  }

  if (configError) {
    return (
      <section className="banner banner-error" role="alert">
        <div>
          <strong>Unable to load runtime configuration:</strong> {configError}
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onRetryConfig}>
          Retry Config
        </button>
      </section>
    );
  }

  if (!config) {
    return null;
  }

  const missingVars = config.missingSetupEnvVars ?? [];
  const hasMissingSetup = missingVars.length > 0;
  const syntheticEnabled = config.capabilities.syntheticDemoEnabled;

  return (
    <div className="banner-stack">
      {useSyntheticDemo && (
        <section
          className="banner banner-demo"
          role="status"
          aria-live="polite"
          data-testid="synthetic-demo-banner"
        >
          <div className="banner-content">
            <span className="pill pill-demo">SYNTHETIC DEMO FIXTURE — NOT LIVE COVERAGE</span>
            <span>
              Displaying explicitly badged synthetic fixtures (`useSyntheticDemo: true`). Not live market
              listings, live AVM valuations, or live upstream coverage.
            </span>
          </div>
          {syntheticEnabled && (
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => onToggleSyntheticDemo(false)}
            >
              Exit Synthetic Demo Mode
            </button>
          )}
        </section>
      )}

      {hasMissingSetup && !useSyntheticDemo && (
        <section
          className="banner banner-setup"
          role="region"
          aria-label="Setup Needed"
          data-testid="setup-needed-banner"
        >
          <div className="banner-content">
            <div className="banner-heading">
              <span className="pill pill-setup">Setup Needed</span>
              <span>
                Some external capabilities are unconfigured on the server. Configure the environment
                variable names below to enable live services (secret values are never exposed to the browser):
              </span>
            </div>
            <ul className="setup-var-list">
              {missingVars.map((item) => (
                <li key={item.envVarName}>
                  <code>{item.envVarName}</code> — {item.feature}
                  {item.requiredForLiveMode ? ' (Required for live listings/AVM)' : ' (Optional — fallback active)'}
                </li>
              ))}
            </ul>
          </div>
          {syntheticEnabled && (
            <div className="banner-actions">
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => onToggleSyntheticDemo(true)}
                aria-pressed={useSyntheticDemo}
              >
                Preview Labeled Synthetic Demo Mode
              </button>
            </div>
          )}
        </section>
      )}

      {!hasMissingSetup && syntheticEnabled && !useSyntheticDemo && (
        <section className="banner banner-subtle" aria-label="Synthetic Demo Option">
          <span>Live configuration detected. Want to inspect offline fixtures without spending API quota?</span>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => onToggleSyntheticDemo(true)}
            aria-pressed={false}
          >
            Preview Labeled Synthetic Demo Mode
          </button>
        </section>
      )}
    </div>
  );
};
