/**
 * Dynamic application shell — Task T18.
 *
 * Reads `podConfig` and renders the navigation, sidebar labels, domain title,
 * and UI density appropriate to the active `domainMode`. Healthcare surfaces
 * clinical + billing pods and uses a compact density; salon/generic surface a
 * lighter set with comfortable density. Compliance links appear only when a
 * privacy regulation is active.
 *
 * `buildNavigation` is exported as a pure function so the routing logic can be
 * unit-tested independently of rendering.
 *
 * Acceptance (matrix T18): displays only active Pod routes; handles domain
 * labels dynamically.
 */
import type { ReactNode } from 'react';
import { podConfig as defaultPodConfig } from '@/config/pod.config';
import type { PodConfig } from '@/config/pod.config';

export interface NavItem {
  key: string;
  label: string;
  path: string;
  /** Owning pod (for grouping / analytics). */
  pod: string;
}

export type UiDensity = 'compact' | 'comfortable';

const DOMAIN_TITLES: Record<PodConfig['domainMode'], string> = {
  HEALTHCARE: 'EHR + RCM',
  SALON: 'Salon Suite',
  GENERIC: 'Scheduler',
};

/** Density is data-driven by domain: clinical work favors information density. */
export function densityFor(config: PodConfig): UiDensity {
  return config.domainMode === 'HEALTHCARE' ? 'compact' : 'comfortable';
}

export function domainTitle(config: PodConfig): string {
  return DOMAIN_TITLES[config.domainMode];
}

/**
 * Compute the active navigation for a given pod configuration. Only routes for
 * enabled pods/regulations are returned, and labels adapt to the domain.
 */
export function buildNavigation(config: PodConfig): NavItem[] {
  const isHealthcare = config.domainMode === 'HEALTHCARE';
  const items: NavItem[] = [];

  items.push({ key: 'dashboard', label: 'Dashboard', path: '/', pod: 'app' });
  items.push({
    key: 'scheduling',
    label: isHealthcare ? 'Appointments' : 'Bookings',
    path: '/scheduling',
    pod: 'scheduling',
  });
  items.push({
    key: 'customers',
    label: isHealthcare ? 'Patients' : 'Clients',
    path: '/customers',
    pod: 'scheduling',
  });

  // Clinical + revenue-cycle pods are healthcare-only.
  if (isHealthcare) {
    items.push({ key: 'clinical', label: 'Clinical Notes', path: '/clinical', pod: 'clinical' });
    items.push({ key: 'rcm', label: 'Billing & Claims', path: '/billing', pod: 'rcm' });
  }

  // Privacy tools appear when any data-protection regulation is active.
  if (config.compliance.gdpr || config.compliance.dpdpa) {
    items.push({ key: 'privacy', label: 'Privacy & Erasure', path: '/privacy', pod: 'compliance' });
  }

  items.push({ key: 'settings', label: 'Settings', path: '/settings', pod: 'auth' });
  return items;
}

export interface AppShellProps {
  config?: PodConfig;
  activePath?: string;
  children?: ReactNode;
}

/**
 * The shell chrome: a domain-titled sidebar with dynamic navigation, plus a
 * main content region for the routed page.
 */
export function AppShell({
  config = defaultPodConfig,
  activePath,
  children,
}: AppShellProps): JSX.Element {
  const items = buildNavigation(config);
  const density = densityFor(config);
  const title = domainTitle(config);

  return (
    <div
      className={`app-shell app-shell--${density}`}
      data-domain={config.domainMode}
      data-density={density}
    >
      <aside className="app-shell__sidebar">
        <h1 className="app-shell__brand">{title}</h1>
        <nav aria-label="Main navigation">
          <ul className="app-shell__nav">
            {items.map((item) => (
              <li key={item.key}>
                <a
                  href={item.path}
                  data-nav-key={item.key}
                  aria-current={activePath === item.path ? 'page' : undefined}
                >
                  {item.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="app-shell__main">{children}</main>
    </div>
  );
}

export default AppShell;
