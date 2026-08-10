/**
 * Tests for Task T18 — AppShell.tsx (React Testing Library / jsdom).
 * Acceptance: displays only active Pod routes; handles domain labels dynamically.
 */
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { AppShell, buildNavigation, densityFor, domainTitle } from '../AppShell';
import { buildPodConfig } from '@/config/pod.config';

const healthcare = buildPodConfig({ DOMAIN_MODE: 'HEALTHCARE' });
const salon = buildPodConfig({ DOMAIN_MODE: 'SALON' });
const generic = buildPodConfig({ DOMAIN_MODE: 'GENERIC' });

describe('buildNavigation (T18)', () => {
  it('includes clinical + billing pods in HEALTHCARE', () => {
    const keys = buildNavigation(healthcare).map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining(['scheduling', 'customers', 'clinical', 'rcm', 'privacy', 'settings']),
    );
  });

  it('excludes clinical + billing pods in SALON', () => {
    const keys = buildNavigation(salon).map((i) => i.key);
    expect(keys).not.toContain('clinical');
    expect(keys).not.toContain('rcm');
    expect(keys).toContain('scheduling');
  });

  it('hides privacy tools when no data-protection regulation is active (GENERIC)', () => {
    const keys = buildNavigation(generic).map((i) => i.key);
    expect(keys).not.toContain('privacy');
    expect(keys).not.toContain('clinical');
  });

  it('relabels shared routes per domain', () => {
    const hc = buildNavigation(healthcare);
    const sl = buildNavigation(salon);
    expect(hc.find((i) => i.key === 'customers')!.label).toBe('Patients');
    expect(sl.find((i) => i.key === 'customers')!.label).toBe('Clients');
    expect(hc.find((i) => i.key === 'scheduling')!.label).toBe('Appointments');
    expect(sl.find((i) => i.key === 'scheduling')!.label).toBe('Bookings');
  });

  it('derives density and title from the domain', () => {
    expect(densityFor(healthcare)).toBe('compact');
    expect(densityFor(salon)).toBe('comfortable');
    expect(domainTitle(healthcare)).toBe('EHR + RCM');
    expect(domainTitle(salon)).toBe('Salon Suite');
  });
});

describe('<AppShell /> (T18)', () => {
  it('renders healthcare chrome: clinical, billing, privacy, patients + compact density', () => {
    const { container } = render(<AppShell config={healthcare} />);
    expect(screen.getByText('EHR + RCM')).toBeInTheDocument();
    expect(screen.getByText('Patients')).toBeInTheDocument();
    expect(screen.getByText('Clinical Notes')).toBeInTheDocument();
    expect(screen.getByText('Billing & Claims')).toBeInTheDocument();
    expect(screen.getByText('Privacy & Erasure')).toBeInTheDocument();

    const shell = container.querySelector('.app-shell');
    expect(shell?.getAttribute('data-density')).toBe('compact');
    expect(shell?.getAttribute('data-domain')).toBe('HEALTHCARE');
  });

  it('renders salon chrome: clients + bookings, no clinical/billing, comfortable density', () => {
    const { container } = render(<AppShell config={salon} />);
    expect(screen.getByText('Salon Suite')).toBeInTheDocument();
    expect(screen.getByText('Clients')).toBeInTheDocument();
    expect(screen.getByText('Bookings')).toBeInTheDocument();
    expect(screen.queryByText('Clinical Notes')).not.toBeInTheDocument();
    expect(screen.queryByText('Billing & Claims')).not.toBeInTheDocument();

    const shell = container.querySelector('.app-shell');
    expect(shell?.getAttribute('data-density')).toBe('comfortable');
  });

  it('marks the active route with aria-current', () => {
    render(<AppShell config={healthcare} activePath="/clinical" />);
    const active = screen.getByText('Clinical Notes');
    expect(active).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('Dashboard')).not.toHaveAttribute('aria-current');
  });

  it('renders routed children in the main region', () => {
    render(
      <AppShell config={healthcare}>
        <p>Page content here</p>
      </AppShell>,
    );
    expect(screen.getByText('Page content here')).toBeInTheDocument();
  });
});
