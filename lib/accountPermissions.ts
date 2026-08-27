import type { AppArea, UserRole } from "./types.ts";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "teacher" || value === "student";
}

export function roleCanAccess(role: UserRole, area: AppArea) {
  return role === "admin" || role === area;
}

export function defaultRouteForRole(role: UserRole) {
  return role === "student" ? "/student" : "/teacher/dashboard";
}
