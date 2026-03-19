import { describe, it, expect } from "vitest"
import { cleanJSONSchemaForAntigravity } from "./request-helpers"

describe("cleanJSONSchemaForAntigravity recursive required cleanup", () => {
  it("removes nullable fields from required array at root", () => {
    const schema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: ["string", "null"] },
      },
      required: ["a", "b"],
    }
    const cleaned = cleanJSONSchemaForAntigravity(schema)
    expect(cleaned.required).toEqual(["a"])
    expect(cleaned.properties.b.description).toContain("nullable")
  })

  it("removes nullable fields from required array recursively", () => {
    const schema = {
      type: "object",
      properties: {
        nested: {
          type: "object",
          properties: {
            c: { type: "string" },
            d: { type: ["string", "null"] },
          },
          required: ["c", "d"],
        },
      },
      required: ["nested"],
    }
    const cleaned = cleanJSONSchemaForAntigravity(schema)
    expect(cleaned.required).toEqual(["nested"])
    expect(cleaned.properties.nested.required).toEqual(["c"])
    expect(cleaned.properties.nested.properties.d.description).toContain("nullable")
  })

  it("handles nullable: true style from OAS", () => {
    const schema = {
      type: "object",
      properties: {
        e: { type: "string", nullable: true },
      },
      required: ["e"],
    }
    const cleaned = cleanJSONSchemaForAntigravity(schema)
    expect(cleaned.required).toBeUndefined()
    expect(cleaned.properties.e.description).toContain("nullable")
    expect(cleaned.properties.e.nullable).toBeUndefined()
  })

  it("handles complex nested arrays", () => {
    const schema = {
      type: "object",
      properties: {
        arr: {
          type: "array",
          items: {
            type: "object",
            properties: {
              f: { type: ["number", "null"] },
              g: { type: "number" },
            },
            required: ["f", "g"],
          },
        },
      },
    }
    const cleaned = cleanJSONSchemaForAntigravity(schema)
    expect(cleaned.properties.arr.items.required).toEqual(["g"])
    expect(cleaned.properties.arr.items.properties.f.description).toContain("nullable")
  })
})
