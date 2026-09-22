import type { AppArea, UserRole } from "./types.ts";

export function isUserRole(value: unknown): value is UserRole {
  return value === "admin" || value === "teacher" || value === "student";
}

/**
 * Interface-area access. Admin can use both areas, and Teacher may enter the
 * Student area through the shared area switcher (same mechanism as Admin
 * student mode). Student stays limited to the Student area; Teacher never
 * gains Admin-only capabilities from this check.
 */
export function roleCanAccess(role: UserRole, area: AppArea) {
  return role === "admin" || role === area || (role === "teacher" && area === "student");
}

/**
 * The Teacher/Student interface switcher is offered to the roles that may use
 * both areas. Student never switches areas.
 */
export function canSwitchArea(role: UserRole) {
  return role === "admin" || role === "teacher";
}

export function defaultRouteForRole(role: UserRole) {
  return role === "student" ? "/student" : "/teacher/dashboard";
}
