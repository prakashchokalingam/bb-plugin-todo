// bb-plugin-todo — frontend entry. Registers exactly one surface: the
// Todo nav panel (tab strip + Backlog/Today board), per docs/SPEC.md's
// "Frontend" section.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
import { definePluginApp } from "@get-bb/plugin-sdk/app";
import { TodoPage } from "@/components/TodoPage";
import TodoHeaderActions from "@/components/TodoHeaderActions";
import OverdueAccessory from "@/components/OverdueAccessory";

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "board",
    title: "Todo",
    icon: "ListTodo",
    path: "todo",
    component: TodoPage,
    headerContent: TodoHeaderActions,
    experimental_sidebarAccessory: OverdueAccessory,
  });
});
