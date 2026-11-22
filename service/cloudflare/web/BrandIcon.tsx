import type { CSSProperties } from 'react';
import { EasyEmailAppIcon } from '../../../apps/desktop/src/components/AppIcons';

// Bind the existing product artwork to the standard theme, not the desktop skin.
const colors = {
  '--nt-surface-control-hover': 'var(--n-control-hover)',
  '--nt-surface-app': 'var(--n-bg)',
  '--nt-action-primary': 'var(--n-yellow)',
  '--nt-action-primary-hover': 'var(--n-primary-hover)',
  '--nt-surface-rail': 'var(--n-rail)',
  '--nt-action-info': 'var(--n-info)',
} as CSSProperties;

export function BrandIcon() {
  return <span className="brand-icon" style={colors}><EasyEmailAppIcon /></span>;
}
