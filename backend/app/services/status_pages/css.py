from dataclasses import dataclass, field
from functools import lru_cache

import tinycss2
from tinycss2 import ast

MAX_BYTES = 65536
MAX_RULES = 2000
MAX_RULE_DEPTH = 3
MAX_VALUE_DEPTH = 16
MAX_TOKENS = 50_000
MAX_ERRORS = 20

ALLOWED_AT_RULES = frozenset({"media", "supports", "keyframes"})
ALLOWED_FUNCTIONS = frozenset({
    "rgb", "rgba", "hsl", "hsla", "hwb", "lab", "lch", "oklab", "oklch", "color-mix",
    "calc", "min", "max", "clamp", "var",
    "linear-gradient", "radial-gradient", "conic-gradient",
    "repeating-linear-gradient", "repeating-radial-gradient", "repeating-conic-gradient",
    "cubic-bezier", "steps",
    "translate", "translatex", "translatey", "rotate", "scale", "scalex", "scaley",
    "skew", "skewx", "skewy", "matrix",
})
SELECTOR_FUNCTIONS = frozenset({
    "not", "is", "where", "has", "nth-child", "nth-last-child", "nth-of-type", "nth-last-of-type",
})
ALLOWED_PSEUDO_ELEMENTS = frozenset({"before", "after", "marker", "selection"})
REJECTED_PROPERTIES = frozenset({"behavior", "-moz-binding"})
HTML_MARKERS = ("<", ">", "</style", "<!--")


@dataclass(frozen=True)
class CssResult:
    ok: bool
    css: str | None
    errors: list[str] = field(default_factory=list)


class _Abort(Exception):
    pass


def _position(node) -> str:
    return f"Line {getattr(node, 'source_line', 1)}, column {getattr(node, 'source_column', 1)}"


def _is_space(token) -> bool:
    return isinstance(token, (ast.WhitespaceToken, ast.Comment))


def _has_marker(value: str) -> bool:
    lowered = value.lower()
    return any(marker in lowered for marker in HTML_MARKERS)


class _Validator:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.tokens = 0
        self.rules = 0

    def error(self, node, message: str) -> None:
        self.errors.append(f"{_position(node)}: {message}")
        if len(self.errors) >= MAX_ERRORS:
            raise _Abort

    def count_rule(self, node) -> None:
        self.rules += 1
        if self.rules > MAX_RULES:
            self.error(node, f"Custom CSS may contain at most {MAX_RULES} rules")
            raise _Abort

    def count_token(self, node) -> None:
        self.tokens += 1
        if self.tokens > MAX_TOKENS:
            self.error(node, "Custom CSS is too complex")
            raise _Abort

    def text_token(self, token) -> None:
        values = [getattr(token, "value", None), getattr(token, "unit", None)]
        if any(isinstance(v, str) and _has_marker(v) for v in values):
            self.error(token, "HTML delimiters such as < and > are not allowed in names or strings")

    def values(self, tokens, depth: int, selector: bool = False) -> None:
        if depth > MAX_VALUE_DEPTH:
            self.error(tokens[0] if tokens else None, "Values are nested too deeply")
            return
        previous: list = []
        for token in tokens:
            self.count_token(token)
            if isinstance(token, ast.Comment) or isinstance(token, ast.WhitespaceToken):
                previous.append(token)
                continue
            self.token(token, depth, selector, previous)
            previous.append(token)

    def token(self, token, depth: int, selector: bool, previous: list) -> None:
        if isinstance(token, ast.ParseError):
            self.error(token, f"Invalid CSS ({token.message})")
        elif isinstance(token, ast.URLToken):
            self.error(token, "url() is not allowed")
        elif isinstance(token, ast.AtKeywordToken):
            self.error(token, f"@{token.lower_value} is not allowed here")
        elif isinstance(token, ast.FunctionBlock):
            if selector:
                self.selector_function(token, previous)
            elif token.lower_name not in ALLOWED_FUNCTIONS:
                self.error(token, f"{token.lower_name}() is not allowed")
            self.values(token.arguments, depth + 1, selector)
        elif isinstance(token, (ast.ParenthesesBlock, ast.SquareBracketsBlock, ast.CurlyBracketsBlock)):
            self.values(token.content, depth + 1, selector)
        elif isinstance(token, ast.LiteralToken):
            if "<" in token.value or token.value == "-->":
                self.error(token, f"'{token.value}' is not allowed")
        elif isinstance(token, (ast.IdentToken, ast.StringToken, ast.HashToken, ast.DimensionToken)):
            self.text_token(token)
            if selector and isinstance(token, ast.IdentToken) and _pseudo_element(previous):
                if token.lower_value not in ALLOWED_PSEUDO_ELEMENTS:
                    self.error(token, f"::{token.lower_value} is not allowed")

    def selector_function(self, token, previous: list) -> None:
        if _pseudo_element(previous):
            self.error(token, f"::{token.lower_name}() is not allowed")
        elif previous and isinstance(previous[-1], ast.LiteralToken) and previous[-1].value == ":":
            if token.lower_name not in SELECTOR_FUNCTIONS:
                self.error(token, f":{token.lower_name}() is not allowed")
        else:
            self.error(token, f"{token.lower_name}() is not allowed in a selector")

    def declaration(self, node) -> str | None:
        name = node.lower_name
        if name in REJECTED_PROPERTIES or "expression" in name:
            self.error(node, f"The {name} property is not allowed")
            return None
        self.values(node.value, 1)
        prop = tinycss2.serialize_identifier(node.name if name.startswith("--") else name)
        value = _prelude(node.value)
        return f"{prop}:{value}{'!important' if node.important else ''}"

    def keyframes(self, node, depth: int) -> str:
        self.values(node.prelude, 1)
        names = [t for t in node.prelude if not _is_space(t)]
        if len(names) != 1 or not isinstance(names[0], (ast.IdentToken, ast.StringToken)):
            self.error(node, "@keyframes needs a single name")
        body = []
        for child in tinycss2.parse_rule_list(node.content, skip_comments=True, skip_whitespace=True):
            if isinstance(child, ast.ParseError):
                self.error(child, f"Invalid CSS ({child.message})")
                continue
            if not isinstance(child, ast.QualifiedRule):
                self.error(child, "Only keyframe blocks are allowed inside @keyframes")
                continue
            self.count_rule(child)
            if depth + 1 > MAX_RULE_DEPTH:
                self.error(child, "Rules are nested too deeply")
                continue
            for token in child.prelude:
                if _is_space(token):
                    continue
                keyword = isinstance(token, ast.IdentToken) and token.lower_value in ("from", "to")
                comma = isinstance(token, ast.LiteralToken) and token.value == ","
                if not (keyword or comma or isinstance(token, ast.PercentageToken)):
                    self.error(token, "Keyframe selectors must be from, to or percentages")
                    break
            declarations = []
            for item in tinycss2.parse_declaration_list(child.content, skip_comments=True, skip_whitespace=True):
                if isinstance(item, ast.Declaration):
                    serialized = self.declaration(item)
                    if serialized is not None:
                        declarations.append(serialized)
                elif isinstance(item, ast.ParseError):
                    self.error(item, f"Invalid CSS ({item.message})")
                else:
                    self.error(item, "Only declarations are allowed inside a keyframe block")
            body.append(_prelude(child.prelude) + "{" + ";".join(declarations) + "}")
        return "".join(body)

    def at_rule(self, node, depth: int, in_style: bool) -> str | None:
        self.count_rule(node)
        keyword = node.lower_at_keyword
        if keyword not in ALLOWED_AT_RULES:
            self.error(node, f"@{keyword} is not allowed")
            return None
        if depth > MAX_RULE_DEPTH:
            self.error(node, "Rules are nested too deeply")
            return None
        if node.content is None:
            self.error(node, f"@{keyword} needs a {{}} block")
            return None
        if keyword == "keyframes":
            body = self.keyframes(node, depth)
        else:
            self.values(node.prelude, 1)
            body = self.block(node.content, depth, in_style)
        head = "@" + tinycss2.serialize_identifier(keyword)
        prelude = _prelude(node.prelude)
        return f"{head} {prelude}{{{body}}}" if prelude else f"{head}{{{body}}}"

    def qualified_rule(self, node, depth: int) -> str | None:
        self.count_rule(node)
        if depth > MAX_RULE_DEPTH:
            self.error(node, "Rules are nested too deeply")
            return None
        self.values(node.prelude, 1, selector=True)
        return _prelude(node.prelude) + "{" + self.block(node.content, depth, True) + "}"

    def block(self, content, depth: int, in_style: bool) -> str:
        if in_style:
            children = tinycss2.parse_blocks_contents(content, skip_comments=True, skip_whitespace=True)
        else:
            children = tinycss2.parse_rule_list(content, skip_comments=True, skip_whitespace=True)
        parts = []
        for child in children:
            if isinstance(child, ast.Declaration):
                serialized = self.declaration(child)
                if serialized is not None:
                    parts.append(serialized + ";")
            else:
                serialized = self.rule(child, depth + 1, in_style)
                if serialized is not None:
                    parts.append(serialized)
        return "".join(parts)

    def rule(self, node, depth: int, in_style: bool) -> str | None:
        if isinstance(node, ast.ParseError):
            self.error(node, f"Invalid CSS ({node.message})")
            return None
        if isinstance(node, ast.AtRule):
            return self.at_rule(node, depth, in_style)
        if isinstance(node, ast.QualifiedRule):
            return self.qualified_rule(node, depth)
        self.error(node, "Unexpected content")
        return None


def _pseudo_element(previous: list) -> bool:
    return (
        len(previous) >= 2
        and all(isinstance(t, ast.LiteralToken) and t.value == ":" for t in previous[-2:])
    )


def _prelude(tokens) -> str:
    return tinycss2.serialize([t for t in tokens if not isinstance(t, ast.Comment)]).strip()


@lru_cache(maxsize=128)
def validate_css(text: str) -> CssResult:
    try:
        size = len(text.encode("utf-8"))
    except UnicodeEncodeError:
        return CssResult(False, None, ["Custom CSS contains invalid characters"])
    if size > MAX_BYTES:
        return CssResult(False, None, ["Custom CSS must be 64 KB or smaller"])
    validator = _Validator()
    parts: list[str] = []
    try:
        for node in tinycss2.parse_stylesheet(text, skip_comments=True, skip_whitespace=True):
            serialized = validator.rule(node, 1, False)
            if serialized is not None:
                parts.append(serialized)
    except _Abort:
        pass
    except RecursionError:
        validator.errors.append("Custom CSS is too complex")
    if validator.errors:
        return CssResult(False, None, validator.errors)
    css = "\n".join(parts)
    lowered = css.lower()
    if "<" in css or "</style" in lowered or "<!--" in lowered:
        return CssResult(False, None, ["Custom CSS contains HTML delimiters"])
    return CssResult(True, css, [])
