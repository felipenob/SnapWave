"""
grammar.py
Offline grammar, casing, and punctuation correction engine.
Adheres strictly to scientific transcription guidelines:
- Capitalizes initial letters and sentences (including after guideline symbols and '…')
- Fixes pronoun 'I' and common contractions
- Separates joined clauses with commas (e.g. before 'but', 'so', 'because')
- Detects interrogatives/questions and adds question marks '?'
- Adds proper terminal punctuation (unless guideline '#' or '…')
- Protects all guideline symbols ([@], [%], [$], [#], […], ^...^, &...&, ~)
"""

import re
from typing import Tuple, List

CONTRACTIONS = {
    "dont": "don't", "Dont": "Don't",
    "cant": "can't", "Cant": "Can't",
    "wont": "won't", "Wont": "Won't",
    "didnt": "didn't", "Didnt": "Didn't",
    "isnt": "isn't", "Isnt": "Isn't",
    "arent": "aren't", "Arent": "Aren't",
    "wasnt": "wasn't", "Wasnt": "Wasn't",
    "werent": "weren't", "Werent": "Weren't",
    "havent": "haven't", "Havent": "Haven't",
    "hasnt": "hasn't", "Hasnt": "Hasn't",
    "hadnt": "hadn't", "Hadnt": "Hadn't",
    "couldnt": "couldn't", "Couldnt": "Couldn't",
    "wouldnt": "wouldn't", "Wouldnt": "Wouldn't",
    "shouldnt": "shouldn't", "Shouldnt": "Shouldn't",
    "thats": "that's", "Thats": "That's",
    "whats": "what's", "Whats": "What's",
    "theres": "there's", "Theres": "There's",
    "lets": "let's", "Lets": "Let's",
    "youre": "you're", "Youre": "You're",
    "theyre": "they're", "Theyre": "They're",
    "weve": "we've", "Weve": "We've",
    "youve": "you've", "Youve": "You've",
    "theyve": "they've", "Theyve": "They've",
    "couldve": "could've", "Couldve": "Could've",
    "wouldve": "would've", "Wouldve": "Would've",
    "shouldve": "should've", "Shouldve": "Should've",
    "im": "I'm", "Im": "I'm",
    "ive": "I've", "Ive": "I've",
    "id": "I'd", "Id": "I'd"
}

QUESTION_STARTERS = {
    "why", "how", "what", "when", "where", "who", "whom", "whose", "which"
}

INVERTED_AUX_PATTERNS = re.compile(
    r"^(is|are|was|were|do|does|did|can|could|would|should|will|have|has|had)\s+(i|you|he|she|it|we|they|this|that|there|anyone|everyone|everybody|someone)\b",
    re.IGNORECASE
)


def _protect_guideline_symbols(text: str) -> Tuple[str, List[str]]:
    """Replaces guideline symbols with temporary placeholders to prevent modification."""
    placeholders = []

    def repl(m):
        idx = len(placeholders)
        placeholders.append(m.group(0))
        return f"__GUIDELINE_TOKEN_{idx}__"

    token_pattern = re.compile(
        r"(\[@\]|\[%\]|\[\$\]|\[#\]|\[…\]|\[~\]|\^[^^]+\^|&[^&]+&|\b\w+#|\b\w+…)"
    )

    protected_text = token_pattern.sub(repl, text)
    return protected_text, placeholders


def _restore_guideline_symbols(text: str, placeholders: List[str]) -> str:
    """Restores guideline placeholders back to original symbols."""
    for idx, orig in enumerate(placeholders):
        text = text.replace(f"__GUIDELINE_TOKEN_{idx}__", orig)
    return text


def correct_grammar_and_punctuation(text: str) -> str:
    """
    Cleans, capitalizes, restores missing punctuation, and formats text.
    Preserves all scientific transcription markers.
    """
    raw = text.strip()
    if not raw:
        return raw

    # Standalone guideline tokens like "[@]" or "[%]" should remain pristine
    if raw in ("[@]", "[%]", "[$]", "[~]", "[#]", "[…]"):
        return raw

    protected, placeholders = _protect_guideline_symbols(raw)

    # 1. Normalize whitespace
    s = re.sub(r"\s+", " ", protected).strip()

    # 2. Fix spaces around punctuation (remove space before , . ? ! ; :)
    s = re.sub(r"\s+([,.:;?!])", r"\1", s)

    # 3. Contraction restoration
    for bad_w, good_w in CONTRACTIONS.items():
        s = re.sub(rf"\b{bad_w}\b", good_w, s)

    # 4. Capitalize standalone pronoun 'I' and 'I'm', 'I've', 'I'll', 'I'd'
    s = re.sub(r"\bi\b", "I", s)
    s = re.sub(r"\bi'([a-zA-Z]+)\b", r"I'\1", s)

    # 5. Stutter hyphen capitalization: e.g. "a-a-and" -> "A-a-and"
    def fix_stutter_case(m):
        full = m.group(0)
        return full[0].upper() + full[1:]
    s = re.sub(r"\b([a-zA-Z])-([a-zA-Z])-\w+\b", fix_stutter_case, s)

    # 6. Comma insertion before coordinating conjunctions and conjunctive adverbs between clauses
    # E.g. "I want this However it's gone" -> "I want this, however it's gone"
    TRANSITION_WORDS = "however|therefore|meanwhile|moreover|furthermore|otherwise|nevertheless|instead|anyway|besides|actually"
    def fix_transition_clause(m):
        prev_w = m.group(1)
        trans = m.group(2).lower()
        next_w = m.group(3)
        return f"{prev_w}, {trans} {next_w}"

    s = re.sub(rf"\b([a-zA-Z0-9']+)\s+({TRANSITION_WORDS})\s+([a-zA-Z0-9']+)\b", fix_transition_clause, s, flags=re.IGNORECASE)

    s = re.sub(r"(\w+)\s+(but|so|because|although)\s+(\w+)", r"\1, \2 \3", s)

    # Discourse marker comma: e.g. "yeah, it is" / "yes, it is" / "well, we"
    s = re.sub(r"\b(yeah|yes|well|oh)\s+(it|that|we|they|i|you|there|this)\b", r"\1, \2", s, flags=re.IGNORECASE)

    # Fix question tags: e.g. "..., or" or "... or?"
    s = re.sub(r"\b(\w+)\s+or\s*(\?|$)", r"\1, or\2", s)
    s = re.sub(r"\b(\w+)\s+right\s*(\?|$)", r"\1, right\2", s)

    # 7. Sentence Capitalization:
    # Capitalize first letter of string (or first letter after leading placeholder)
    s = re.sub(r"(^|[.?!…]\s+|__GUIDELINE_TOKEN_\d+__\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), s)

    # 8. Detect if sentence is an interrogative / question
    # Extract real words without placeholders
    cleaned_words = re.findall(r"\b[A-Za-z]+\b", re.sub(r"__GUIDELINE_TOKEN_\d+__", "", s))
    first_word = cleaned_words[0].lower() if cleaned_words else ""
    is_question = False

    if first_word in QUESTION_STARTERS:
        is_question = True
    elif INVERTED_AUX_PATTERNS.match(s):
        is_question = True
    else:
        # Check if the final clause contains a question starter or ends with a tag question
        clauses = s.split(",")
        last_clause = clauses[-1].strip().lower()
        last_clause_words = set(re.findall(r"\b[a-z]+\b", last_clause))
        if any(qw in last_clause_words for qw in QUESTION_STARTERS):
            is_question = True
        elif re.search(r"\b(or|right|you know)\s*\??$", last_clause):
            is_question = True

    # 9. Spacing around commas and colons
    s = re.sub(r"([,;:])([^\s\d\)])", r"\1 \2", s)

    # 10. Restore protected guideline symbols
    restored = _restore_guideline_symbols(s, placeholders).strip()

    # 11. Terminal Punctuation:
    if restored.endswith("#") or restored.endswith("…"):
        return restored

    if is_question:
        if restored.endswith("."):
            restored = restored[:-1] + "?"
        elif not restored.endswith(("?", "!")):
            restored += "?"
    else:
        if not restored.endswith((".", "?", "!")):
            restored += "."

    return restored
