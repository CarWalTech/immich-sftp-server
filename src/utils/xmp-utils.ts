import { XMLParser } from 'fast-xml-parser';
export class XMPUtils
{
    static readonly PARSER_OPTIONS = {
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        isArray: (name: string) => name === 'rdf:li',
        parseAttributeValue: false,
        parseTagValue: false,
        trimValues: true,
        processEntities: true,
    };

    static readonly BUILDER_OPTIONS = {
        ignoreAttributes: false,
        attributeNamePrefix: '@_',
        format: true,
        indentBy: '  ',
        suppressEmptyNode: true,
        processEntities: true,
    };

    static parseSidecar(xmp: string): Record<string, any>
    {
        try
        {
            const parser = new XMLParser(this.PARSER_OPTIONS);
            return parser.parse(xmp);
        }
        catch { return {}; }
    }

    static getDescNode(parsed: Record<string, any>): Record<string, any>
    {
        return parsed?.['x:xmpmeta']?.['rdf:RDF']?.['rdf:Description'] ?? {};
    }

    static extractAltText(desc: Record<string, any>, prop: string): string | undefined
    {
        const lis: any[] = desc?.[prop]?.['rdf:Alt']?.['rdf:li'] ?? [];
        const preferred = lis.find(li => li?.['@_xml:lang'] === 'x-default');
        const item = preferred ?? lis[0];
        if (!item) return undefined;
        const text = typeof item === 'string' ? item : String(item['#text'] ?? '');
        return text.trim() || undefined;
    }

    static extractListValues(desc: Record<string, any>, prop: string): string[]
    {
        const container = desc?.[prop];
        if (!container) return [];
        const lis: any[] =
            container['rdf:Bag']?.['rdf:li'] ??
            container['rdf:Seq']?.['rdf:li'] ??
            container['rdf:Alt']?.['rdf:li'] ??
            [];
        return lis.map(li => (typeof li === 'string' ? li : String(li?.['#text'] ?? '')).trim()).filter(Boolean);
    }

    static extractSimpleValue(desc: Record<string, any>, prop: string): string | undefined
    {
        const val = desc?.[prop];
        if (val === undefined || val === null) return undefined;
        const str = String(val).trim();
        return str || undefined;
    }

    static formatGPS(decimal: number, posRef: string, negRef: string): string
    {
        const abs = Math.abs(decimal);
        const deg = Math.floor(abs);
        const minDecimal = (abs - deg) * 60;
        return `${deg},${minDecimal.toFixed(6)}${decimal >= 0 ? posRef : negRef}`;
    }

    // Parses XMP GPS strings back to decimal degrees.
    // Handles: "47,7.407360N" (D,decimal-min ref), "47,7,24.500N" (D,M,S ref), "47.1234567" (decimal)
    static parseGPS(value: string): number | undefined
    {
        const trimmed = value.trim();
        if (!trimmed) return undefined;

        const ref = /[NSEWnsew]$/.exec(trimmed)?.[0]?.toUpperCase();
        const numeric = trimmed.replace(/[NSEWnsew]$/i, '').trim();
        const parts = numeric.split(',').map(s => parseFloat(s.trim()));

        let decimal: number;
        if (parts.length === 1 && !isNaN(parts[0]))
        {
            decimal = parts[0];
        }
        else if (parts.length === 2 && parts.every(n => !isNaN(n)))
        {
            decimal = parts[0] + parts[1] / 60;
        }
        else if (parts.length === 3 && parts.every(n => !isNaN(n)))
        {
            decimal = parts[0] + parts[1] / 60 + parts[2] / 3600;
        }
        else
        {
            return undefined;
        }

        if (ref === 'S' || ref === 'W') decimal = -decimal;
        return decimal;
    }

    static buildHierarchical(tags: string[]): string[]
    {
        const result: string[] = [];
        for (const tag of tags)
        {
            const parts = tag.split('/');
            for (let i = 1; i <= parts.length; i++)
            {
                const segment = parts.slice(0, i).join('/');
                if (!result.includes(segment)) result.push(segment);
            }
        }
        return result;
    }
}

