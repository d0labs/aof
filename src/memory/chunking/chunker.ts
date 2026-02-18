export type Chunk = {
  content: string;
  startLine: number;
  endLine: number;
  headings: string[];
};

type Paragraph = {
  content: string;
  startLine: number;
  endLine: number;
  headings: string[];
  isHeading: boolean;
};

const DEFAULT_MAX_CHUNK_SIZE = 2048;
const DEFAULT_OVERLAP = 1;

const headingRegex = /^(##|###)\s+(.*)$/;

const updateHeadings = (current: string[], level: number, text: string) => {
  if (level === 2) {
    return [text];
  }

  if (current.length === 0) {
    return [text];
  }

  return [current[0], text];
};

const finalizeParagraph = (
  paragraphs: Paragraph[],
  buffer: string[],
  startLine: number,
  endLine: number,
  headings: string[],
) => {
  if (buffer.length === 0) {
    return;
  }

  paragraphs.push({
    content: buffer.join("\n"),
    startLine,
    endLine,
    headings: [...headings],
    isHeading: false,
  });

  buffer.length = 0;
};

const parseParagraphs = (content: string): Paragraph[] => {
  const lines = content.split(/\r?\n/);
  const paragraphs: Paragraph[] = [];
  const buffer: string[] = [];
  let currentHeadings: string[] = [];
  let paragraphStart = 1;
  let paragraphEnd = 1;

  lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const headingMatch = line.match(headingRegex);

    if (headingMatch) {
      finalizeParagraph(
        paragraphs,
        buffer,
        paragraphStart,
        paragraphEnd,
        currentHeadings,
      );

      const level = headingMatch[1].length;
      const headingText = headingMatch[2].trim();
      currentHeadings = updateHeadings(currentHeadings, level, headingText);

      paragraphs.push({
        content: line,
        startLine: lineNumber,
        endLine: lineNumber,
        headings: [...currentHeadings],
        isHeading: true,
      });

      return;
    }

    if (line.trim() === "") {
      finalizeParagraph(
        paragraphs,
        buffer,
        paragraphStart,
        paragraphEnd,
        currentHeadings,
      );
      return;
    }

    if (buffer.length === 0) {
      paragraphStart = lineNumber;
    }

    buffer.push(line);
    paragraphEnd = lineNumber;
  });

  finalizeParagraph(
    paragraphs,
    buffer,
    paragraphStart,
    paragraphEnd,
    currentHeadings,
  );

  return paragraphs;
};

const chunkSize = (paragraphs: Paragraph[]) =>
  paragraphs.reduce(
    (total, paragraph, index) =>
      total + paragraph.content.length + (index > 0 ? 2 : 0),
    0,
  );

const buildChunk = (paragraphs: Paragraph[]): Chunk => ({
  content: paragraphs.map((paragraph) => paragraph.content).join("\n\n"),
  startLine: paragraphs[0].startLine,
  endLine: paragraphs[paragraphs.length - 1].endLine,
  headings: paragraphs[0].headings,
});

export const chunkMarkdown = (
  content: string,
  opts?: { maxChunkSize?: number; overlap?: number },
): Chunk[] => {
  const maxChunkSize = opts?.maxChunkSize ?? DEFAULT_MAX_CHUNK_SIZE;
  const overlapCount = opts?.overlap ?? DEFAULT_OVERLAP;
  const paragraphs = parseParagraphs(content);
  const chunks: Chunk[] = [];
  let current: Paragraph[] = [];
  let currentSize = 0;
  let overlapBuffer: Paragraph[] = [];

  const flush = (shouldOverlap: boolean) => {
    if (current.length === 0) {
      return;
    }

    chunks.push(buildChunk(current));

    if (shouldOverlap && overlapCount > 0) {
      overlapBuffer = current.slice(-overlapCount);
    } else {
      overlapBuffer = [];
    }

    current = [];
    currentSize = 0;
  };

  const seedFromOverlap = () => {
    if (overlapBuffer.length === 0) {
      return;
    }

    current = [...overlapBuffer];
    currentSize = chunkSize(current);
  };

  paragraphs.forEach((paragraph) => {
    if (paragraph.isHeading && current.length > 0) {
      flush(false);
      overlapBuffer = [];
    }

    if (current.length === 0) {
      seedFromOverlap();
    }

    const separator = current.length > 0 ? 2 : 0;
    const nextSize = currentSize + separator + paragraph.content.length;

    if (nextSize > maxChunkSize && current.length > 0) {
      flush(true);
      seedFromOverlap();
    }

    if (current.length > 0) {
      currentSize += 2;
    }

    current.push(paragraph);
    currentSize += paragraph.content.length;
  });

  flush(false);

  return chunks;
};
