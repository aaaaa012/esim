import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import {
  CatalogController,
  type CatalogService,
  normalizePlanName,
  parseDataAllowanceMb,
} from "./catalog.controller.js";

describe("catalog allowance normalization", () => {
  it("normalizes common provider allowance units", () => {
    expect(parseDataAllowanceMb("500 MB")).toBe(500);
    expect(parseDataAllowanceMb("1 GB")).toBe(1024);
    expect(parseDataAllowanceMb("1.5GB")).toBe(1536);
    expect(parseDataAllowanceMb("1 TB")).toBe(1024 * 1024);
  });

  it("leaves non-comparable allowances explicit", () => {
    expect(parseDataAllowanceMb("Unlimited")).toBeNull();
    expect(parseDataAllowanceMb("")).toBeNull();
  });

  it("canonicalizes provider labels and removes unexplained Unlimited claims", () => {
    expect(normalizePlanName("One-Off Usa 500MB 1 day Sim", "500 MB")).toBe(
      "One-Off USA 500 MB 1 day eSIM",
    );
    expect(normalizePlanName("Unlimited data 10GB", "10 GB")).toBe(
      "10 GB",
    );
  });
});

describe("public catalog plan filters", () => {
  it("allows short caching for public countries only", () => {
    const countries = vi.fn().mockReturnValue([]);
    const response = {
      setHeader: vi.fn(),
      vary: vi.fn(),
    } as unknown as Response;
    const controller = new CatalogController({ countries } as unknown as CatalogService);

    expect(controller.countries(response)).toEqual([]);
    expect(response.setHeader).toHaveBeenCalledWith(
      "Cache-Control",
      "public, max-age=30, stale-while-revalidate=60",
    );
    expect(response.vary).toHaveBeenCalledWith("Origin");
  });

  it("passes popular-only and a capped limit to the catalog service", () => {
    const plans = vi.fn().mockReturnValue([]);
    const controller = new CatalogController({
      plans,
    } as unknown as CatalogService);

    controller.plans("JP", "true", "100");

    expect(plans).toHaveBeenCalledWith("JP", {
      popularOnly: true,
      limit: 24,
    });
  });

  it("rejects invalid public filter values", () => {
    const controller = new CatalogController({
      plans: vi.fn(),
    } as unknown as CatalogService);
    expect(() => controller.plans(undefined, "yes")).toThrow(
      "popular must be true or false",
    );
    expect(() => controller.plans(undefined, undefined, "0")).toThrow(
      "limit must be a positive integer",
    );
  });
});
