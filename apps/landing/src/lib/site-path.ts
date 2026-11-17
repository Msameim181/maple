/**
 * The site's sub-path ("" on maple.dev). The GitHub Pages copy of the docs is served under
 * /<repo>/ and sets ASTRO_BASE, which Astro reports in `Astro.url.pathname`; code that reads
 * the locale prefix from the pathname must strip it first.
 */
export const siteBase = import.meta.env.BASE_URL.replace(/\/+$/, "")

export const pathWithoutBase = (pathname: string): string =>
	siteBase !== "" && pathname.startsWith(siteBase) ? pathname.slice(siteBase.length) || "/" : pathname
