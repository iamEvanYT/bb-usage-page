import { definePluginApp } from "@bb/plugin-sdk/app";
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
});
