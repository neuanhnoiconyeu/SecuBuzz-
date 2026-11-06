import { render, screen, within } from '@testing-library/react';
import { BRAND_ASSETS, BRAND_NAME, BrandIcon, BrandLogo } from '..';

function expectOptimizedAsset(image: Element | null, source: string) {
  expect(image).not.toBeNull();
  const optimizedUrl = new URL(image?.getAttribute('src') ?? '', 'http://localhost');
  expect(optimizedUrl.pathname).toBe('/_next/image');
  expect(optimizedUrl.searchParams.get('url')).toBe(source);
  expect(optimizedUrl.searchParams.get('q')).toBe('90');
  expect(image).toHaveAttribute('srcset', expect.stringContaining('/_next/image?'));
}

describe('brand identity components', () => {
  test('uses the supplied full artwork with its original aspect ratio and an informative name', () => {
    render(<BrandLogo />);

    const logo = screen.getByRole('img', { name: BRAND_NAME });
    expectOptimizedAsset(logo, BRAND_ASSETS.full);
    expect(logo).toHaveAttribute('sizes', '352px');
    expect(logo).toHaveAttribute('width', '1784');
    expect(logo).toHaveAttribute('height', '882');
  });

  test('exposes one accessible identity for the compact icon and readable product name', () => {
    render(<BrandLogo variant="compact" label="Messenger home" size="sm" />);

    const logo = screen.getByRole('img', { name: 'Messenger home' });
    expect(within(logo).getByText('Yahoo! Security')).toBeInTheDocument();
    expect(within(logo).getByText('Messenger 2.0')).toBeInTheDocument();
    expectOptimizedAsset(logo.querySelector('img'), BRAND_ASSETS.icon);
    expect(logo.querySelector('img')).toHaveAttribute('sizes', '20px');
    expect(logo.querySelector('img')).toHaveAttribute('alt', '');
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  test('keeps decorative branding out of the accessibility tree', () => {
    const { container } = render(<BrandLogo variant="compact" decorative />);

    expect(screen.queryByRole('img')).not.toBeInTheDocument();
    expect(container.querySelector('.brand-logo')).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('img')).toHaveAttribute('alt', '');
  });

  test('BrandIcon uses the icon artwork without a duplicated text logo', () => {
    render(<BrandIcon size="lg" label="Yahoo Messenger application" />);

    const icon = screen.getByRole('img', { name: 'Yahoo Messenger application' });
    expectOptimizedAsset(icon, BRAND_ASSETS.icon);
    expect(icon).toHaveAttribute('sizes', '80px');
    expect(screen.queryByText('Yahoo! Security')).not.toBeInTheDocument();
    expect(screen.getAllByRole('img')).toHaveLength(1);
  });

  test('requests responsive artwork widths for the large full logo', () => {
    render(<BrandLogo size="lg" />);

    const logo = screen.getByRole('img', { name: BRAND_NAME });
    expectOptimizedAsset(logo, BRAND_ASSETS.full);
    expect(logo).toHaveAttribute('sizes', '(max-width: 680px) 280px, 416px');
    expect(logo).toHaveAttribute('width', '1784');
    expect(logo).toHaveAttribute('height', '882');
  });
});
