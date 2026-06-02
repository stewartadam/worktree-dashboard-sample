
const heroIconMarkupByPath = import.meta.glob(
  "../assets/heroicons/24/outline/*.svg",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
) as Record<string, string>;

const heroIconTemplateCache = new Map<string, SVGSVGElement>();
const PRESERVED_HOST_ATTRIBUTES = new Set([
  "aria-hidden",
  "class",
  "data-component",
  "role",
  "style",
]);

function getHeroIconPath(icon: string): string {
  return `../assets/heroicons/24/outline/${icon}.svg`;
}

function getHeroIconMarkup(icon: string): string {
  const markup = heroIconMarkupByPath[getHeroIconPath(icon)];
  if (!markup) {
    throw new Error(`Missing heroicon "${icon}"`);
  }
  return markup;
}

function getHeroIconTemplate(icon: string): SVGSVGElement {
  let template = heroIconTemplateCache.get(icon);
  if (template) {
    return template;
  }

  const documentFragment = new DOMParser().parseFromString(
    getHeroIconMarkup(icon),
    "image/svg+xml",
  );
  const svg = documentFragment.documentElement;

  if (
    svg.localName !== "svg" ||
    svg.namespaceURI !== "http://www.w3.org/2000/svg"
  ) {
    throw new Error(`Heroicon "${icon}" did not parse as an SVG element`);
  }
  if (!(svg instanceof SVGSVGElement)) {
    throw new Error(`Heroicon "${icon}" did not parse as an SVGSVGElement`);
  }

  heroIconTemplateCache.set(icon, svg);
  template = svg;
  return template;
}

export function renderHeroIcon(
  host: SVGSVGElement,
  icon: string | undefined,
): void {
  host.replaceChildren();

  if (!icon) {
    return;
  }

  try {
    const template = getHeroIconTemplate(icon);
    const currentAttributes = Array.from(
      host.attributes,
      (attribute) => attribute.name,
    );
    for (const attributeName of currentAttributes) {
      if (!PRESERVED_HOST_ATTRIBUTES.has(attributeName)) {
        host.removeAttribute(attributeName);
      }
    }

    for (const attribute of template.attributes) {
      if (!PRESERVED_HOST_ATTRIBUTES.has(attribute.name)) {
        host.setAttribute(attribute.name, attribute.value);
      }
    }

    host.append(
      ...Array.from(template.childNodes, (childNode) =>
        document.importNode(childNode, true),
      ),
    );
  } catch (error) {
    console.warn("Failed to render heroicon", { icon, error });
  }
}
