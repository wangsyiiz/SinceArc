import type { ComponentProps } from "react";
import { SettingsView } from "@/components/SettingsView";

type SettingsRouteProps = ComponentProps<typeof SettingsView>;

export function SettingsRoute(props: SettingsRouteProps) {
  return <SettingsView {...props} />;
}
