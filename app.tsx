import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { ProviderSettings } from "@/components/usage/provider-settings";
import { UsagePage } from "@/components/usage/usage-page";
import "./app.css";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "usage",
    title: "Usage",
    icon: "ChartColumn",
    path: "usage",
    component: UsagePage,
  });
  app.slots.settingsSection({
    id: "providers",
    title: "Providers",
    description:
      "Choose which agents count toward usage and the order they appear in.",
    component: ProviderSettings,
  });
});
