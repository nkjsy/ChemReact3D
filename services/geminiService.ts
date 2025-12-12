
import { GoogleGenAI, Type } from "@google/genai";
import { Molecule, ReactionResult, ElementType } from '../types';
import { autoLayoutMolecule } from './layoutService';

const getClient = () => {
  const apiKey = process.env.API_KEY;
  if (!apiKey) {
    throw new Error("API Key not found");
  }
  return new GoogleGenAI({ apiKey });
};

/**
 * Uses Gemini 3 to calculate scientifically accurate 3D coordinates.
 */
export const getAccurate3DStructure = async (molecule: Molecule): Promise<Molecule> => {
  const ai = getClient();
  
  if (molecule.atoms.length === 0) return molecule;

  const atomList = molecule.atoms.map(a => `ID:${a.id} Element:${a.element}`).join(', ');
  const bondList = molecule.bonds.map(b => `${b.sourceAtomId}-${b.targetAtomId} (Order:${b.order})`).join(', ');

  const systemInstruction = `
    You are a 3D Computational Chemistry Engine.
    Calculate VSEPR 3D coordinates (x, y, z) for this molecule.
    Return coordinates in Angstroms (typical bond lengths 1.0 - 2.0).
    
    CRITICAL RULES:
    1. Do NOT put all atoms on a single plane or line unless chemically required (e.g. Benzene is flat, CO2 is linear).
    2. Respect correct bond angles (Tetrahedral ~109.5, Trigonal Planar ~120).
    3. Ensure ring structures (like Cyclohexane chair conformation) are 3D if applicable.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Structure for:\nAtoms: ${atomList}\nBonds: ${bondList}`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            atoms: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  x: { type: Type.NUMBER },
                  y: { type: Type.NUMBER },
                  z: { type: Type.NUMBER }
                },
                required: ["id", "x", "y", "z"]
              }
            }
          }
        }
      }
    });

    const data = JSON.parse(response.text || "{}");
    const newCoords = new Map<string, {x: number, y: number, z: number}>(
      (data.atoms || []).map((a: any) => [String(a.id), a])
    );

    let updatedAtoms = molecule.atoms.map(atom => {
      const coords = newCoords.get(atom.id);
      if (coords) {
        return { ...atom, x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) };
      }
      return atom;
    });

    // Scale check
    let totalBondLen = 0;
    let bondCount = 0;
    molecule.bonds.forEach(b => {
      const a1 = updatedAtoms.find(a => a.id === b.sourceAtomId);
      const a2 = updatedAtoms.find(a => a.id === b.targetAtomId);
      if (a1 && a2) {
        const d = Math.sqrt(Math.pow(a1.x - a2.x, 2) + Math.pow(a1.y - a2.y, 2) + Math.pow(a1.z - a2.z, 2));
        if (d > 0.1) {
          totalBondLen += d;
          bondCount++;
        }
      }
    });

    const avgLen = bondCount > 0 ? totalBondLen / bondCount : 0;
    const TARGET_VISUAL_BOND_LENGTH = 3.0; 
    const scale = (avgLen > 0.1) ? (TARGET_VISUAL_BOND_LENGTH / avgLen) : 1;

    updatedAtoms = updatedAtoms.map(a => ({
      ...a,
      x: a.x * scale,
      y: a.y * scale,
      z: a.z * scale
    }));

    // Center
    let cx = 0, cy = 0, cz = 0;
    updatedAtoms.forEach(a => { cx += a.x; cy += a.y; cz += a.z; });
    cx /= updatedAtoms.length; cy /= updatedAtoms.length; cz /= updatedAtoms.length;

    updatedAtoms = updatedAtoms.map(a => ({
      ...a,
      x: a.x - cx,
      y: a.y - cy,
      z: a.z - cz
    }));

    return { ...molecule, atoms: updatedAtoms };

  } catch (error: any) {
    // Graceful fallback for quota limits or other errors
    if (error.status === 429 || error.message?.includes('429')) {
      console.warn("Gemini Quota Exceeded for 3D layout. Using local physics engine.");
    } else {
      console.error("3D Structure Error:", error);
    }
    // Fallback to physics engine
    return autoLayoutMolecule(molecule, 400, 400); 
  }
};

/**
 * Identifies a molecule.
 */
export const identifyMolecule = async (molecule: Molecule): Promise<string> => {
  const ai = getClient();

  const atomList = molecule.atoms.map(a => `${a.element} (id:${a.id})`).join(', ');
  const bondList = molecule.bonds.map(b => `${b.sourceAtomId}-${b.targetAtomId} (order:${b.order})`).join(', ');
  
  const counts: Record<string, number> = {};
  molecule.atoms.forEach(a => {
    counts[a.element] = (counts[a.element] || 0) + 1;
  });
  const formula = Object.entries(counts).map(([el, count]) => `${el}${count > 1 ? count : ''}`).join('');

  const systemInstruction = `
    Identify the common name of this molecule.
    If no common name, use IUPAC.
    Return ONLY the name string.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Atoms: ${atomList}\nBonds: ${bondList}\nFormula Hint: ${formula}`,
      config: {
        systemInstruction,
        responseMimeType: "text/plain",
      }
    });
    
    let name = response.text?.trim();
    if (!name || name.length > 50) return formula;
    return name;
  } catch (error) {
    return formula;
  }
};

/**
 * Generates reaction prediction.
 */
export const simulateReaction = async (reactants: Molecule[]): Promise<ReactionResult> => {
  const ai = getClient();

  const reactantDescriptions = reactants.map(r => {
    const counts: Record<string, number> = {};
    r.atoms.forEach(a => {
      counts[a.element] = (counts[a.element] || 0) + 1;
    });
    const formula = Object.entries(counts).map(([el, count]) => `${el}${count > 1 ? count : ''}`).join('');
    return `${r.name || 'Unknown Molecule'} (${formula})`;
  }).join(' + ');

  const systemInstruction = `
    You are an expert computational chemist. 
    1. Predict the reaction.
    2. Balance the equation.
    3. Generate product structures.
    
    CRITICAL: 
    - Provide an ESTIMATE of the 3D coordinates (x, y, z) for the product atoms to form a valid chemical structure.
    - If unsure about coordinates, just provide valid connectivity and the system will auto-layout.
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-pro-preview",
      contents: `Reactants: ${reactantDescriptions}`,
      config: {
        systemInstruction,
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            equation: { type: Type.STRING },
            explanation: { type: Type.STRING },
            products: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  atoms: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        id: { type: Type.STRING },
                        element: { type: Type.STRING },
                        x: { type: Type.NUMBER, description: "Estimated X coordinate" },
                        y: { type: Type.NUMBER, description: "Estimated Y coordinate" },
                        z: { type: Type.NUMBER, description: "Estimated Z coordinate" }
                      },
                      required: ["id", "element"]
                    }
                  },
                  bonds: {
                    type: Type.ARRAY,
                    items: {
                      type: Type.OBJECT,
                      properties: {
                        source: { type: Type.STRING },
                        target: { type: Type.STRING },
                        order: { type: Type.INTEGER }
                      },
                      required: ["source", "target", "order"]
                    }
                  }
                },
                required: ["name", "atoms", "bonds"]
              }
            }
          },
          required: ["equation", "explanation", "products"]
        }
      }
    });

    const text = response.text;
    if (!text) throw new Error("No response from AI");
    
    const data = JSON.parse(text);

    // Process products synchronously to save API calls
    const products = (data.products || []).map((p: any, index: number) => {
      const validAtoms = (p.atoms || []).filter((a: any) => a.id && a.element);
      const atomIdSet = new Set(validAtoms.map((a: any) => String(a.id)));

      const validBonds = (p.bonds || []).filter((b: any) => 
        atomIdSet.has(String(b.source)) && atomIdSet.has(String(b.target))
      );
      
      // Check if the AI provided usable coordinates
      const hasCoords = validAtoms.some((a: any) => 
        (a.x !== undefined && a.x !== 0) || (a.y !== undefined && a.y !== 0)
      );

      const rawMolecule: Molecule = {
        id: `product-${index}-${Date.now()}`,
        name: p.name || "Product",
        atoms: validAtoms.map((a: any) => ({
          id: String(a.id),
          element: a.element as ElementType, 
          x: Number(a.x) || 0, 
          y: Number(a.y) || 0,
          z: Number(a.z) || 0
        })),
        bonds: validBonds.map((b: any, bIndex: number) => ({
          id: `bond-${index}-${bIndex}`,
          sourceAtomId: String(b.source),
          targetAtomId: String(b.target),
          order: b.order || 1
        }))
      };

      if (hasCoords) {
        // If Gemini provided coordinates in the single shot, use them directly (after a quick centering)
        // This avoids N extra API calls
        let cx = 0, cy = 0, cz = 0;
        rawMolecule.atoms.forEach(a => { cx += a.x; cy += a.y; cz += a.z; });
        cx /= rawMolecule.atoms.length || 1; 
        cy /= rawMolecule.atoms.length || 1; 
        cz /= rawMolecule.atoms.length || 1;
        
        rawMolecule.atoms = rawMolecule.atoms.map(a => ({
          ...a, x: a.x - cx, y: a.y - cy, z: a.z - cz
        }));
        
        return rawMolecule;
      } else {
        // Fallback to local physics engine immediately to save quota
        return autoLayoutMolecule(rawMolecule, 600, 400);
      }
    });

    return {
      equation: data.equation || "Reaction Complete",
      explanation: data.explanation || "The reactants formed new products.",
      products
    };

  } catch (error: any) {
    if (error.status === 429) {
      throw new Error("API Quota exceeded. Please try again later.");
    }
    console.error("Gemini Error:", error);
    throw new Error("Failed to simulate reaction. Please try again.");
  }
};
