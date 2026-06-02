import { createEffect } from "solid-js";
import { renderHeroIcon } from "../lib/heroicons";

interface HeroIconProps {
  icon: string | undefined;
  class?: string;
}

export default function HeroIcon(props: HeroIconProps) {
  if (props.icon === undefined) return;
  let iconRef: SVGSVGElement | undefined;

  createEffect(() => {
    const icon = iconRef;
    if (!icon) {
      return;
    }
    renderHeroIcon(icon, props.icon);
  });

  return (
    <svg
      ref={iconRef}
      class={props.class ?? "dark:text-gray-400 text-gray-400"}
      data-component="HeroIcon"
      role="img"
      aria-hidden="true"
    />
  );
}
