import type { Router } from "express";
import { describe, expect, it } from "vitest";
import { VIEWPORT_APPROXIMATION_DISCLAIMER } from "../../src/shared/constants";
import { createDefaultPreferenceProfile } from "../../src/shared/schemas";
import type { AnalysisArea } from "../../src/shared/types";
import { loadServerConfig } from "../../src/server/config";
import { computeBoundingBoxForRadius } from "../../src/server/geospatial/scoring";
import { createGeospatialModule } from "../../src/server/geospatial/router";

/**
 * In-memory Express Router dispatcher compatible with sandboxed environments
 * (exercises route matching, Zod validation, service execution, and error responses
 * without binding TCP loopback sockets).
 */
function dispatchRouterRequest(
  router: Router,
  method: "GET" | "POST",
  url: string,
  body?: unknown
): Promise<{ status: number; body: any }> {
  return new Promise((resolve) => {
    let statusCode = 200;

    const req: any = {
      method,
      url,
      originalUrl: `/api/geospatial${url}`,
      path: url,
      body,
      headers: { "content-type": "application/json" },
    };

    const res: any = {
      status(code: number) {
        statusCode = code;
        return res;
      },
      json(data: any) {
        resolve({ status: statusCode, body: data });
        return res;
      },
      setHeader() {
        return res;
      },
    };

    router(req, res, (err?: any) => {
      if (err) {
        resolve({
          status: 500,
          body: { error: { code: "INTERNAL_ERROR", message: String(err) } },
        });
      } else {
        resolve({
          status: 404,
          body: { error: { code: "NOT_FOUND", message: "Route not found" } },
        });
      }
    });
  });
}

const AUSTIN_AREA: AnalysisArea = {
  areaId: "austin_tx_1600",
  label: "Austin, TX",
  centerLat: 30.2672,
  centerLng: -97.7431,
  radiusMeters: 1600,
  boundingBox: computeBoundingBoxForRadius(
    { lat: 30.2672, lng: -97.7431 },
    1600
  ),
  city: "Austin",
  state: "TX",
  zipCode: "78701",
  isUsLocation: true,
  isViewportApproximation: true,
  approximationDisclaimer: VIEWPORT_APPROXIMATION_DISCLAIMER,
};

describe("Geospatial Router & Service (`POST /api/geospatial/analyze`)", () => {
  it("analyzes a US area with live mocked Overpass + EPA FRS data and rejects forged google_places_context records", async () => {
    const config = loadServerConfig({
      NODE_ENV: "test",
      ENABLE_SYNTHETIC_DEMO_MODE: "false",
      GOOGLE_PLACES_SERVER_KEY: "test_places_key_secret",
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input.toString();

      if (url.includes("overpass")) {
        return new Response(
          JSON.stringify({
            elements: [
              {
                type: "node",
                id: 1001,
                lat: 30.268,
                lon: -97.743,
                tags: { shop: "supermarket", name: "Downtown Austin Grocery" },
              },
              {
                type: "way",
                id: 1002,
                center: { lat: 30.2665, lon: -97.744 },
                tags: { leisure: "park", name: "Republic Square Park" },
              },
              {
                type: "node",
                id: 1003,
                lat: 30.2675,
                lon: -97.742,
                tags: { railway: "station", name: "Downtown MetroRail Station" },
              },
              // Bare industrial building without EPA program -> must remain neutral
              {
                type: "way",
                id: 1004,
                center: { lat: 30.2672, lon: -97.7431 },
                tags: { landuse: "industrial", name: "Neutral Warehouse" },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("epa.gov")) {
        return new Response(
          JSON.stringify({
            Results: {
              FRSFacility: [
                {
                  RegistryId: "110000787010",
                  FacilityName: "Austin Water Treatment Facility",
                  Latitude83: "30.2610",
                  Longitude83: "-97.7500",
                  PGM_SYS_ACRNMS: "NPDES, ICIS-AIR",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.includes("places.googleapis.com")) {
        return new Response(
          JSON.stringify({
            places: [
              {
                id: "gplace_ctx_1",
                displayName: { text: "Display-Only Coffee Shop" },
                location: { latitude: 30.2673, longitude: -97.7432 },
                primaryType: "cafe",
                formattedAddress: "100 Congress Ave, Austin, TX",
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      return new Response("Not Found", { status: 404 });
    };

    const geoModule = createGeospatialModule(config, {
      fetchImpl: mockFetch,
      // Inject a forged google_places_context candidate claiming analysisEligible: true
      extraCandidateFacilities: [
        {
          id: "forged_gplace_99",
          sourceId: "google_places_context",
          analysisEligible: true,
          category: "grocery",
          name: "Forged Google Places Grocery",
          lat: 30.2672,
          lng: -97.7431,
        },
      ],
    });

    const response = await dispatchRouterRequest(
      geoModule.geospatialRouter,
      "POST",
      "/analyze",
      {
        analysisArea: AUSTIN_AREA,
        preferences: createDefaultPreferenceProfile(),
        evaluatePoints: [{ id: "prop_1", lat: 30.2678, lng: -97.7432 }],
        clientRequestSeq: 7,
      }
    );

    expect(response.status).toBe(200);
    expect(response.body.uiState).toBe("ready");
    expect(response.body.dataMode).toBe("live_open_data");
    expect(response.body.isSyntheticDemo).toBe(false);
    expect(response.body.clientRequestSeq).toBe(7);

    // Influence fetch radius = 1600m + max(radius_c=2400m) = 4000m
    expect(response.body.influenceFetchRadiusMeters).toBe(4000);

    // Verify forged google_places_context was rejected from scoring and amenities
    expect(response.body.centerAccessibility.rejectedFacilityCount).toBe(1);
    expect(
      response.body.centerAccessibility.rejectedCountBySource.google_places_context
    ).toBe(1);
    expect(
      response.body.amenities.some(
        (a: { sourceId: string }) => a.sourceId === "google_places_context"
      )
    ).toBe(false);

    // Display-only places context is returned strictly in displayOnlyPlacesContext with analysisEligible: false
    expect(response.body.displayOnlyPlacesContext).toHaveLength(1);
    expect(response.body.displayOnlyPlacesContext[0].sourceId).toBe(
      "google_places_context"
    );
    expect(response.body.displayOnlyPlacesContext[0].analysisEligible).toBe(
      false
    );

    // Environmental layer populated from EPA FRS
    expect(response.body.environmentalLayer.status).toBe("ok");
    expect(response.body.environmentalLayer.records).toHaveLength(1);
    expect(
      response.body.environmentalLayer.records[0].isAutomaticHealthDetermination
    ).toBe(false);

    // Point evaluation and server cache lookup (`scorePointForArea`)
    expect(response.body.pointEvaluations.prop_1).toBeDefined();
    expect(response.body.pointEvaluations.prop_1.score).toBeGreaterThan(0);

    const cachedScore = geoModule.scorePointForArea("austin_tx_1600", {
      lat: 30.2678,
      lng: -97.7432,
    });
    expect(cachedScore).not.toBeNull();
    expect(cachedScore?.accessibility.score).toBeGreaterThan(0);
    expect(geoModule.getCachedAreaGeospatial("austin_tx_1600")).not.toBeNull();
  });

  it("handles Overpass API failure as completeness=unknown and EPA FRS failure as environmentalLayer.status=unknown", async () => {
    const config = loadServerConfig({
      NODE_ENV: "test",
      ENABLE_SYNTHETIC_DEMO_MODE: "false",
    });

    const failingFetch: typeof fetch = async () =>
      new Response("Gateway Timeout", { status: 504 });

    const geoModule = createGeospatialModule(config, {
      fetchImpl: failingFetch,
    });

    const res = await dispatchRouterRequest(
      geoModule.geospatialRouter,
      "POST",
      "/analyze",
      {
        analysisArea: AUSTIN_AREA,
        preferences: createDefaultPreferenceProfile(),
      }
    );

    expect(res.status).toBe(200);
    expect(res.body.uiState).toBe("timeout");
    expect(res.body.centerAccessibility.completeness).toBe("unknown");
    expect(
      res.body.centerAccessibility.failedWeightedCategories.length
    ).toBeGreaterThan(0);
    expect(res.body.environmentalLayer.status).toBe("unknown");
  });

  it("supports opt-in Synthetic Demo mode when enabled and blocks it when disabled", async () => {
    const disabledConfig = loadServerConfig({
      NODE_ENV: "test",
      ENABLE_SYNTHETIC_DEMO_MODE: "false",
    });
    const disabledModule = createGeospatialModule(disabledConfig);

    const blockedRes = await dispatchRouterRequest(
      disabledModule.geospatialRouter,
      "POST",
      "/analyze",
      {
        analysisArea: AUSTIN_AREA,
        useSyntheticDemo: true,
      }
    );
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.body.error.code).toBe("SETUP_NEEDED");

    const enabledConfig = loadServerConfig({
      NODE_ENV: "test",
      ENABLE_SYNTHETIC_DEMO_MODE: "true",
    });
    const enabledModule = createGeospatialModule(enabledConfig);

    const synthRes = await dispatchRouterRequest(
      enabledModule.geospatialRouter,
      "POST",
      "/analyze",
      {
        analysisArea: AUSTIN_AREA,
        useSyntheticDemo: true,
      }
    );

    expect(synthRes.status).toBe(200);
    expect(synthRes.body.uiState).toBe("synthetic_demo");
    expect(synthRes.body.isSyntheticDemo).toBe(true);
    expect(synthRes.body.centerAccessibility.score).toBeGreaterThan(0);
    expect(
      synthRes.body.centerAccessibility.duplicatesMergedCount
    ).toBeGreaterThanOrEqual(1);
    expect(synthRes.body.environmentalLayer.records.length).toBe(2);
  });

  it("rejects non-US coordinates with 422 UNSUPPORTED_AREA and invalid payloads with 400 VALIDATION_ERROR", async () => {
    const config = loadServerConfig({ NODE_ENV: "test" });
    const geoModule = createGeospatialModule(config);

    const londonArea: AnalysisArea = {
      ...AUSTIN_AREA,
      areaId: "london_uk",
      label: "London, UK",
      centerLat: 51.5074,
      centerLng: -0.1278,
      boundingBox: computeBoundingBoxForRadius(
        { lat: 51.5074, lng: -0.1278 },
        1600
      ),
    };

    const nonUsRes = await dispatchRouterRequest(
      geoModule.geospatialRouter,
      "POST",
      "/analyze",
      {
        analysisArea: londonArea,
      }
    );
    expect(nonUsRes.status).toBe(422);
    expect(nonUsRes.body.error.code).toBe("UNSUPPORTED_AREA");
    expect(nonUsRes.body.error.uiState).toBe("unsupported_area");

    const invalidRes = await dispatchRouterRequest(
      geoModule.geospatialRouter,
      "POST",
      "/analyze",
      {
        analysisArea: {
          ...AUSTIN_AREA,
          centerLat: 120, // invalid latitude > 90
        },
      }
    );
    expect(invalidRes.status).toBe(400);
    expect(invalidRes.body.error.code).toBe("VALIDATION_ERROR");
  });
});
