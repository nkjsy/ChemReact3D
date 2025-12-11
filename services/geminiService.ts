
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

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    // First pass: Update coords and find bounds
    let updatedAtoms = molecule.atoms.map(atom => {
      const coords = newCoords.get(atom.id);
      if (coords) {
        return { ...atom, x: Number(coords.x), y: Number(coords.y), z: Number(coords.z) };
      }
      return atom;
    });

    // Heuristic: Check average bond length to determine scaling
    // Renderer expects bonds around 3-4 units. Angstroms are ~1.5.
    // We calculate current average bond length from the AI response.
    let totalBondLen = 0;
    let bondCount = 0;
    
    molecule.bonds.forEach(b => {
      const a1 = updatedAtoms.find(a => a.id === b.sourceAtomId);
      const a2 = updatedAtoms.find(a => a.id === b.targetAtomId);
      if (a1 && a2) {
        const d = Math.sqrt(Math.pow(a1.x - a2.x, 2) + Math.pow(a1.y - a2.y, 2) + Math.pow(a1.z - a2.z, 2));
        if (d > 0.1) { // avoid zero length errors
          totalBondLen += d;
          bondCount++;
        }
      }
    });

    const avgLen = bondCount > 0 ? totalBondLen / bondCount : 0;
    
    // Target visual bond length for the renderer
    const TARGET_VISUAL_BOND_LENGTH = 3.0; 
    const scale = (avgLen > 0.1) ? (TARGET_VISUAL_BOND_LENGTH / avgLen) : 1;

    // Second pass: Scale and Center
    // Recalculate bounds after potential scaling
    updatedAtoms = updatedAtoms.map(a => ({
      ...a,
      x: a.x * scale,
      y: a.y * scale,
      z: a.z * scale
    }));

    // Find center
    let cx = 0, cy = 0, cz = 0;
    updatedAtoms.forEach(a => {
      cx += a.x;
      cy += a.y;
      cz += a.z;
    });
    cx /= updatedAtoms.length;
    cy /= updatedAtoms.length;
    cz /= updatedAtoms.length;

    // Apply centering
    updatedAtoms = updatedAtoms.map(a => ({
      ...a,
      x: a.x - cx,
      y: a.y - cy,
      z: a.z - cz
    }));

    // IMPORTANT: Return directly. Do NOT run autoLayoutMolecule() which uses a generic physics engine
    // that might destroy the specific chemical geometry (like chair conformations) returned by the AI.
    return { ...molecule, atoms: updatedAtoms };

  } catch (error) {
    console.error("3D Structure Error:", error);
    // Fallback to physics engine if AI fails
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
    
    IMPORTANT: Return a connectivity graph (atoms/bonds). 
    The 'x, y, z' coordinates are optional but if provided, must not be linear for 3D molecules.
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

    const products: Molecule[] = (data.products || []).map((p: any, index: number) => {
      const validAtoms = (p.atoms || []).filter((a: any) => a.id && a.element);
      const atomIdSet = new Set(validAtoms.map((a: any) => String(a.id)));

      const validBonds = (p.bonds || []).filter((b: any) => 
        atomIdSet.has(String(b.source)) && atomIdSet.has(String(b.target))
      );

      // Create raw molecule with NO coordinates initially (0,0,0)
      // This triggers the "needsScramble" logic in autoLayoutMolecule
      const rawMolecule = {
        id: `product-${index}-${Date.now()}`,
        name: p.name || "Product",
        atoms: validAtoms.map((a: any) => ({
          id: String(a.id),
          element: a.element as ElementType, 
          x: 0, 
          y: 0,
          z: 0
        })),
        bonds: validBonds.map((b: any, bIndex: number) => ({
          id: `bond-${index}-${bIndex}`,
          sourceAtomId: String(b.source),
          targetAtomId: String(b.target),
          order: b.order || 1
        }))
      };

      // Since these are new products without coords, we MUST run autoLayout
      // But we call it with a flag (implied by 0,0,0 coords) to do a full scramble
      return autoLayoutMolecule(rawMolecule, 600, 400);
    });

    return {
      equation: data.equation || "Reaction Complete",
      explanation: data.explanation || "The reactants formed new products.",
      products
    };

  } catch (error) {
    console.error("Gemini Error:", error);
    throw new Error("Failed to simulate reaction. Please try again.");
  }
};
