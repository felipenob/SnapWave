import sys
import os

BACKEND_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "backend")
sys.path.insert(0, BACKEND_DIR)

from grammar import correct_grammar_and_punctuation

test_cases = [
    ("this is basi#", "This is basi#"),
    ("i mean… this is how we do it or", "I mean… This is how we do it, or?"),
    ("you are funny but yeah it is true", "You are funny, but yeah, it is true."),
    ("we should think about it so how is your side", "We should think about it, so how is your side?"),
    ("what is your pattern idea", "What is your pattern idea?"),
    ("im not sure because we dont have time", "I'm not sure, because we don't have time."),
    ("[@]", "[@]"),
    ("[%]", "[%]"),
    ("^ah^ that is it", "^ah^ That is it."),
    ("&bonjour& how are you", "&bonjour& How are you?"),
    ("a-a-and this is my idea", "A-a-and this is my idea."),
    ("I want this However it's gone", "I want this, however it's gone."),
]

def run():
    all_passed = True
    for inp, expected in test_cases:
        out = correct_grammar_and_punctuation(inp)
        print(f"IN:  {inp}")
        print(f"OUT: {out}")
        print(f"EXP: {expected}")
        match = (out == expected)
        print(f"MATCH: {match}")
        print("-" * 40)
        if not match:
            all_passed = False
    assert all_passed, "Some grammar test cases failed!"
    print("\n[SUCCESS] All grammar test cases passed!")

if __name__ == "__main__":
    run()
