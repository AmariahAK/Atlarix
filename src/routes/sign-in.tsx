import { createRoute } from "@tanstack/react-router";
import { rootRoute } from "./root";
import { SignInPage } from "../pages/sign-in";

export const signInRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/sign-in",
  component: SignInPage,
});
