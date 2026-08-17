// src/analyzer/parsers/csharp-parser.ts
// @ts-ignore - Suppress type error due to potential module resolution/typing issues
import Parser from 'tree-sitter';
// @ts-ignore - Suppress type error for grammar module
import CSharp from 'tree-sitter-c-sharp';
import path from 'path';
import fs from 'fs/promises';
import { createContextLogger } from '../../utils/logger.js';
import { ParserError } from '../../utils/errors.js';
import { FileInfo } from '../../scanner/file-scanner.js';
import { AstNode, RelationshipInfo, SingleFileParseResult, InstanceCounter, NamespaceDeclarationNode, UsingDirectiveNode, CSharpClassNode, CSharpInterfaceNode, CSharpStructNode, CSharpMethodNode, PropertyNode, FieldNode } from '../types.js';
import { ensureTempDir, getTempFilePath, generateInstanceId, generateEntityId, relativizeFilePath } from '../parser-utils.js';

const logger = createContextLogger('CSharpParser');

// Helper to get node text safely
function getNodeText(node: Parser.SyntaxNode | null | undefined): string {
    return node?.text ?? '';
}

// Helper to get location
function getNodeLocation(node: Parser.SyntaxNode): { startLine: number, endLine: number, startColumn: number, endColumn: number } {
    return {
        startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
        startColumn: node.startPosition.column, endColumn: node.endPosition.column,
    };
}

/**
 * Extract the simple (unqualified, non-generic) name from a base_list type node.
 * Handles: identifier ("BaseClass"), generic_name ("BaseClass<T>"), qualified_name ("System.Web.Mvc.Controller")
 */
function getBaseSimpleName(node: Parser.SyntaxNode): string {
    switch (node.type) {
        case 'identifier':
            return node.text;
        case 'generic_name': {
            // firstNamedChild is the identifier token (e.g. "TbbCrudController" from "TbbCrudController<Customer>")
            const first = node.firstNamedChild;
            if (first) return first.text || node.text.split('<').shift() || node.text;
            return node.text.split('<').shift() || node.text;
        }
        case 'qualified_name': {
            // Last named child is the rightmost identifier (e.g. "Controller" from "System.Web.Mvc.Controller")
            const children = node.namedChildren;
            const last = children[children.length - 1];
            if (last) return last.text || node.text.split('.').pop() || node.text;
            return node.text.split('.').pop() || node.text;
        }
        default: {
            // Fallback: strip generics and take last dotted segment
            const withoutGenerics = node.text.split('<').shift() || node.text;
            return withoutGenerics.split('.').pop() || withoutGenerics;
        }
    }
}

/**
 * Extract all attribute names from attribute_list children of a node.
 * Returns simple names: [HttpGet] → "HttpGet", [ValidateAntiForgeryToken] → "ValidateAntiForgeryToken"
 */
function extractAttributeNames(node: Parser.SyntaxNode): string[] {
    const names: string[] = [];
    for (const child of node.namedChildren) {
        if (child.type !== 'attribute_list') continue;
        for (const attr of child.namedChildren) {
            if (attr.type !== 'attribute') continue;
            // Field 'name' on attribute node gives identifier/qualified_name/generic_name
            const nameNode = attr.childForFieldName('name') ?? attr.firstNamedChild;
            if (!nameNode) continue;
            const simpleName = getBaseSimpleName(nameNode);
            if (simpleName) names.push(simpleName);
        }
    }
    return names;
}

/**
 * Extract base class name and implemented interface names from a base_list.
 * Uses C# naming convention: I[A-Z]... pattern = interface, otherwise = base class (first only).
 */
function extractBaseList(node: Parser.SyntaxNode, kind: 'CSharpClass' | 'CSharpInterface' | 'CSharpStruct'): {
    baseClassName?: string;
    implementedInterfaces: string[];
} {
    const baseList = node.namedChildren.find(c => c.type === 'base_list');
    if (!baseList) return { implementedInterfaces: [] };

    const result: { baseClassName?: string; implementedInterfaces: string[] } = { implementedInterfaces: [] };

    for (const b of baseList.namedChildren) {
        const simpleName = getBaseSimpleName(b);
        if (!simpleName) continue;

        if (kind === 'CSharpInterface') {
            // Interface declarations: all base_list entries are extended interfaces
            result.implementedInterfaces.push(simpleName);
        } else {
            // Class/Struct: convention I[A-Z]... = interface, otherwise = base class (single inheritance)
            if (/^I[A-Z]/.test(simpleName)) {
                result.implementedInterfaces.push(simpleName);
            } else if (!result.baseClassName) {
                result.baseClassName = simpleName;
            } else {
                // Unexpected second non-I base — treat as interface (defensive)
                result.implementedInterfaces.push(simpleName);
            }
        }
    }

    return result;
}

// --- Tree-sitter Visitor ---
class CSharpAstVisitor {
    public nodes: AstNode[] = [];
    public relationships: RelationshipInfo[] = [];
    private instanceCounter: InstanceCounter = { count: 0 };
    private fileNode: AstNode;
    private now: string = new Date().toISOString();
    private currentNamespace: string | null = null;
    private currentNamespaceId: string | null = null; // Store entityId of namespace
    private currentContainerId: string | null = null; // Class, Struct, Interface entityId

    constructor(private filepath: string) {
        const filename = path.basename(filepath);
        const fileEntityId = generateEntityId('file', filepath);
        this.fileNode = {
            id: generateInstanceId(this.instanceCounter, 'file', filename),
            entityId: fileEntityId, kind: 'File', name: filename, filePath: filepath,
            startLine: 1, endLine: 0, startColumn: 0, endColumn: 0,
            language: 'C#', createdAt: this.now,
        };
        this.nodes.push(this.fileNode);
    }

    // Corrected visit method: process node, then always recurse
    visit(node: Parser.SyntaxNode) {
        const originalNamespaceId = this.currentNamespaceId; // Backup context
        const originalContainerId = this.currentContainerId; // Backup context

        const stopRecursion = this.visitNode(node); // Process the current node first

        if (!stopRecursion) { // Only recurse if the handler didn't stop it
            for (const child of node.namedChildren) {
                this.visit(child);
            }
        }

        // Restore context if we are exiting the node where it was set
        if (this.currentNamespaceId !== originalNamespaceId && node.type === 'namespace_declaration') {
             this.currentNamespaceId = originalNamespaceId;
        }
         if (this.currentContainerId !== originalContainerId && ['class_declaration', 'interface_declaration', 'struct_declaration'].includes(node.type)) {
             this.currentContainerId = originalContainerId;
         }


        if (node.type === 'compilation_unit') { // Root node type for C#
             this.fileNode.endLine = node.endPosition.row + 1;
             this.fileNode.loc = this.fileNode.endLine;
        }
    }

    // Helper to decide if recursion should stop for certain node types
    private shouldStopRecursion(node: Parser.SyntaxNode): boolean {
        // Stop recursion after handling the entire import block here
        return node.type === 'using_directive'; // Using directives don't have relevant children to recurse into here
    }


    private visitNode(node: Parser.SyntaxNode): boolean { // Return boolean to indicate if recursion should stop
        try {
            switch (node.type) {
                case 'namespace_declaration':
                    this.visitNamespaceDeclaration(node);
                    return false; // Allow recursion
                case 'using_directive':
                    this.visitUsingDirective(node);
                    return true; // Stop recursion
                case 'class_declaration':
                    this.visitContainerDeclaration(node, 'CSharpClass');
                    return false; // Allow recursion
                case 'interface_declaration':
                     this.visitContainerDeclaration(node, 'CSharpInterface');
                     return false; // Allow recursion
                case 'struct_declaration':
                     this.visitContainerDeclaration(node, 'CSharpStruct');
                     return false; // Allow recursion
                case 'method_declaration':
                     this.visitMethodDeclaration(node);
                     return false; // Allow recursion
                case 'property_declaration':
                     this.visitPropertyDeclaration(node);
                     return false; // Allow recursion
                case 'field_declaration':
                     this.visitFieldDeclaration(node);
                     return false; // Allow recursion
                default:
                    return false; // Allow recursion for unhandled types
            }
        } catch (error: any) {
             logger.warn(`[CSharpAstVisitor] Error visiting node type ${node.type} in ${this.filepath}: ${error.message}`);
             return false; // Allow recursion even on error
        }
    }

    private visitNamespaceDeclaration(node: Parser.SyntaxNode) {
        const location = getNodeLocation(node);
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        if (!name) return;

        this.currentNamespace = name;
        const entityId = generateEntityId('namespacedeclaration', `${this.filepath}:${name}`);
        this.currentNamespaceId = entityId;

        const nsNode: NamespaceDeclarationNode = {
            id: generateInstanceId(this.instanceCounter, 'namespace', name, { line: location.startLine, column: location.startColumn }),
            entityId: entityId, kind: 'NamespaceDeclaration', name: name,
            filePath: this.filepath, language: 'C#', ...location, createdAt: this.now,
        };
        this.nodes.push(nsNode);

        const relEntityId = generateEntityId('declares_namespace', `${this.fileNode.entityId}:${entityId}`);
        this.relationships.push({
            id: generateInstanceId(this.instanceCounter, 'declares_namespace', `${this.fileNode.id}:${nsNode.id}`),
            entityId: relEntityId, type: 'DECLARES_NAMESPACE',
            sourceId: this.fileNode.entityId, targetId: entityId,
            createdAt: this.now, weight: 9,
        });
    }

    private visitUsingDirective(node: Parser.SyntaxNode) {
        const location = getNodeLocation(node);
        const aliasNode = node.childForFieldName('alias');
        const alias = aliasNode ? getNodeText(aliasNode.childForFieldName('name')) : undefined;
        const isStatic = node.children.some((c: Parser.SyntaxNode) => c.type === 'static');

        // Find the first named child that is an identifier or qualified name
        const nameNode = node.namedChildren.find(c => c.type === 'identifier' || c.type === 'qualified_name');
        const namespaceOrType = getNodeText(nameNode);

        if (!namespaceOrType) {
             logger.warn(`[CSharpAstVisitor] Could not extract name for using_directive at ${this.filepath}:${location.startLine}`);
             return;
        }

        const entityId = generateEntityId('usingdirective', `${this.filepath}:${namespaceOrType}:${location.startLine}`);
        const usingNode: UsingDirectiveNode = {
            id: generateInstanceId(this.instanceCounter, 'using', namespaceOrType, { line: location.startLine, column: location.startColumn }),
            entityId: entityId, kind: 'UsingDirective', name: namespaceOrType,
            filePath: this.filepath, language: 'C#', ...location, createdAt: this.now,
            properties: { namespaceOrType, isStatic, alias }
        };
        this.nodes.push(usingNode);

        const relEntityId = generateEntityId('csharp_using', `${this.fileNode.entityId}:${entityId}`);
        this.relationships.push({
            id: generateInstanceId(this.instanceCounter, 'csharp_using', `${this.fileNode.id}:${usingNode.id}`),
            entityId: relEntityId, type: 'CSHARP_USING',
            sourceId: this.fileNode.entityId, targetId: entityId,
            createdAt: this.now, weight: 5,
        });
    }

    private visitContainerDeclaration(node: Parser.SyntaxNode, kind: 'CSharpClass' | 'CSharpInterface' | 'CSharpStruct') {
        const location = getNodeLocation(node);
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        if (!name) return;

        const qualifiedName = this.currentNamespace ? `${this.currentNamespace}.${name}` : name;
        const entityId = generateEntityId(kind.toLowerCase(), qualifiedName);

        // --- Phase A: Extract inheritance / implementation info ---
        const { baseClassName, implementedInterfaces } = extractBaseList(node, kind);

        // --- Phase A: Extract C# attribute names ([HttpGet], [Route], etc.) ---
        const attributeNames = extractAttributeNames(node);

        const containerNode: AstNode = {
            id: generateInstanceId(this.instanceCounter, kind.toLowerCase(), name, { line: location.startLine, column: location.startColumn }),
            entityId: entityId, kind: kind, name: name,
            filePath: this.filepath, language: 'C#', ...location, createdAt: this.now,
            properties: {
                qualifiedName,
                // Inheritance (stored as top-level Neo4j properties after spread)
                ...(baseClassName ? { baseClassName } : {}),
                ...(implementedInterfaces.length > 0 ? { implementedInterfaces } : {}),
                // Attributes (e.g. migration signals: WebMethod, OperationContract, HttpGet)
                ...(attributeNames.length > 0 ? { attributeNames } : {}),
            },
            parentId: this.currentNamespaceId ?? undefined
        };
        this.nodes.push(containerNode);
        this.currentContainerId = entityId;

        const parentNodeId = this.currentNamespaceId ?? this.fileNode.entityId;
        const relType = kind === 'CSharpClass' ? 'DEFINES_CLASS' : (kind === 'CSharpInterface' ? 'DEFINES_INTERFACE' : 'DEFINES_STRUCT');
        const relEntityId = generateEntityId(relType.toLowerCase(), `${parentNodeId}:${entityId}`);
        this.relationships.push({
            id: generateInstanceId(this.instanceCounter, relType.toLowerCase(), `${parentNodeId}:${containerNode.id}`),
            entityId: relEntityId, type: relType,
            sourceId: parentNodeId, targetId: entityId,
            createdAt: this.now, weight: 9,
        });
    }

     private visitMethodDeclaration(node: Parser.SyntaxNode) {
        if (!this.currentContainerId) return;

        const location = getNodeLocation(node);
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        if (!name) return;

        // --- Phase A: Extract return type (field 'returns' in tree-sitter-c-sharp grammar) ---
        const returnTypeNode = node.childForFieldName('returns');
        const returnType = returnTypeNode ? getNodeText(returnTypeNode) : undefined;

        // --- Phase A: Extract attribute names on this method ---
        const attributeNames = extractAttributeNames(node);

        // --- Phase A: Extract parameter types (for migration signal detection) ---
        const paramList = node.childForFieldName('parameters');
        const parameterTypes: string[] = [];
        if (paramList) {
            for (const param of paramList.namedChildren) {
                if (param.type === 'parameter') {
                    const typeNode = param.childForFieldName('type');
                    if (typeNode) parameterTypes.push(typeNode.text);
                }
            }
        }

        const methodEntityId = generateEntityId('csharpmethod', `${this.currentContainerId}.${name}`);
        const methodNode: CSharpMethodNode = {
            id: generateInstanceId(this.instanceCounter, 'csharpmethod', name, { line: location.startLine, column: location.startColumn }),
            entityId: methodEntityId, kind: 'CSharpMethod', name: name,
            filePath: this.filepath, language: 'C#', ...location, createdAt: this.now,
            parentId: this.currentContainerId,
            returnType: returnType,
            properties: {
                ...(attributeNames.length > 0 ? { attributeNames } : {}),
                ...(parameterTypes.length > 0 ? { parameterTypes } : {}),
            },
        };
        this.nodes.push(methodNode);

        // Relationship: Container -> HAS_METHOD -> Method
        const relEntityId = generateEntityId('has_method', `${this.currentContainerId}:${methodEntityId}`);
        this.relationships.push({
            id: generateInstanceId(this.instanceCounter, 'has_method', `${this.currentContainerId}:${methodNode.id}`),
            entityId: relEntityId, type: 'HAS_METHOD',
            sourceId: this.currentContainerId, targetId: methodEntityId,
            createdAt: this.now, weight: 8,
        });
    }

     private visitPropertyDeclaration(node: Parser.SyntaxNode) {
        if (!this.currentContainerId) return;

        const location = getNodeLocation(node);
        const nameNode = node.childForFieldName('name');
        const name = getNodeText(nameNode);
        if (!name) return;

        const attributeNames = extractAttributeNames(node);

        const propEntityId = generateEntityId('property', `${this.currentContainerId}.${name}`);
        const propNode: PropertyNode = {
            id: generateInstanceId(this.instanceCounter, 'property', name, { line: location.startLine, column: location.startColumn }),
            entityId: propEntityId, kind: 'Property', name: name,
            filePath: this.filepath, language: 'C#', ...location, createdAt: this.now,
            parentId: this.currentContainerId,
            // Store attribute names under `properties` for consistency with class/method nodes
            // and to remain inside AstNode's typed shape (no excess top-level field).
            ...(attributeNames.length > 0 ? { properties: { attributeNames } } : {}),
        };
        this.nodes.push(propNode);

        // Relationship: Container -> HAS_PROPERTY -> Property
        const relEntityId = generateEntityId('has_property', `${this.currentContainerId}:${propEntityId}`);
        this.relationships.push({
            id: generateInstanceId(this.instanceCounter, 'has_property', `${this.currentContainerId}:${propEntityId}`),
            entityId: relEntityId, type: 'HAS_PROPERTY',
            sourceId: this.currentContainerId, targetId: propEntityId,
            createdAt: this.now, weight: 7,
        });
    }

     private visitFieldDeclaration(node: Parser.SyntaxNode) {
        if (!this.currentContainerId) return;

        const location = getNodeLocation(node);
        // Attributes are declared once per field_declaration; propagate to each variable.
        const attributeNames = extractAttributeNames(node);
        // tree-sitter-c-sharp models a field as `field_declaration > variable_declaration > variable_declarator+`,
        // and `variable_declaration` is an UNNAMED child (no field-name). `childForFieldName('declaration')`
        // returns null here, so we look it up by node type instead.
        const declarationNode = node.namedChildren.find(c => c.type === 'variable_declaration');
        if (!declarationNode) return;

        for (const declarator of declarationNode.namedChildren) {
             if (declarator.type === 'variable_declarator') {
                 const nameNode = declarator.childForFieldName('name');
                 const name = getNodeText(nameNode);
                 if (!name) continue;

                 const fieldEntityId = generateEntityId('field', `${this.currentContainerId}.${name}`);
                 const fieldNode: FieldNode = {
                     id: generateInstanceId(this.instanceCounter, 'field', name, { line: location.startLine, column: location.startColumn }),
                     entityId: fieldEntityId, kind: 'Field', name: name,
                     filePath: this.filepath, language: 'C#', ...location, createdAt: this.now,
                     parentId: this.currentContainerId,
                     // Store attribute names under `properties` for consistency with class/method nodes.
                     ...(attributeNames.length > 0 ? { properties: { attributeNames } } : {}),
                 };
                 this.nodes.push(fieldNode);

                 // Relationship: Container -> HAS_FIELD -> Field
                 const relEntityId = generateEntityId('has_field', `${this.currentContainerId}:${fieldEntityId}`);
                 this.relationships.push({
                     id: generateInstanceId(this.instanceCounter, 'has_field', `${this.currentContainerId}:${fieldNode.id}`),
                     entityId: relEntityId, type: 'HAS_FIELD',
                     sourceId: this.currentContainerId, targetId: fieldEntityId,
                     createdAt: this.now, weight: 7,
                 });
             }
        }
    }
}

/**
 * Parses C# files using Tree-sitter.
 */
export class CSharpParser {
    private parser: Parser;

    constructor() {
        this.parser = new Parser();
        this.parser.setLanguage(CSharp as any); // Cast to any to bypass type conflict
        logger.debug('C# Tree-sitter Parser initialized');
    }

    /**
     * Parses a single C# file.
     */
    async parseFile(file: FileInfo, basePath?: string): Promise<string> {
        logger.info(`[CSharpParser] Starting C# parsing for: ${file.name}`);
        await ensureTempDir();
        const tempFilePath = getTempFilePath(file.path);
        const absoluteFilePath = path.resolve(file.path);
        // Compute a repo-relative path when basePath is provided. Falls back to absolute when
        // the file is outside basePath — see relativizeFilePath JSDoc for full semantics.
        const normalizedFilePath = relativizeFilePath(absoluteFilePath, basePath);

        try {
            const fileContent = await fs.readFile(absoluteFilePath, 'utf-8');
            const tree = this.parser.parse(fileContent);
            const visitor = new CSharpAstVisitor(normalizedFilePath);
            visitor.visit(tree.rootNode);

            const result: SingleFileParseResult = {
                filePath: normalizedFilePath,
                nodes: visitor.nodes,
                relationships: visitor.relationships,
            };

            await fs.writeFile(tempFilePath, JSON.stringify(result, null, 2));
            logger.info(`[CSharpParser] Pass 1 completed for: ${file.name}. Nodes: ${result.nodes.length}, Rels: ${result.relationships.length}. Saved to ${path.basename(tempFilePath)}`);
            return tempFilePath;

        } catch (error: any) {
            logger.error(`[CSharpParser] Error during C# Pass 1 for ${file.path}`, {
                 errorMessage: error.message, stack: error.stack?.substring(0, 500)
            });
            try { await fs.unlink(tempFilePath); } catch { /* ignore */ }
            throw new ParserError(`Failed C# Pass 1 parsing for ${file.path}`, { originalError: error });
        }
    }
}