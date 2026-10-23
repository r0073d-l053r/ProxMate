import { describe, it, expect, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

import { NumberInput } from "./number-input";

afterEach(cleanup);

function Harness({ initial = 1, min, max }: { initial?: number; min?: number; max?: number }) {
  const [n, setN] = useState(initial);
  return (
    <>
      <NumberInput aria-label="cores" value={n} min={min} max={max} onValueChange={setN} />
      <button onClick={() => setN(8)}>preset</button>
      <output data-testid="value">{n}</output>
    </>
  );
}

const field = () => screen.getByLabelText("cores") as HTMLInputElement;
const value = () => screen.getByTestId("value").textContent;

describe("NumberInput", () => {
  it("can be emptied and retyped without a stuck 0", () => {
    render(<Harness initial={1} min={1} />);
    fireEvent.change(field(), { target: { value: "" } });
    expect(field().value).toBe("");
    fireEvent.change(field(), { target: { value: "2" } });
    expect(field().value).toBe("2");
    expect(value()).toBe("2");
  });

  it("doesn't clamp to the minimum while the user is still typing", () => {
    render(<Harness initial={30} min={21} />);
    fireEvent.change(field(), { target: { value: "2" } });
    expect(field().value).toBe("2");
    fireEvent.change(field(), { target: { value: "25" } });
    expect(value()).toBe("25");
  });

  it("clamps and tidies the value when the field loses focus", () => {
    render(<Harness initial={4} min={1} max={16} />);
    fireEvent.change(field(), { target: { value: "99" } });
    fireEvent.blur(field());
    expect(field().value).toBe("16");
    expect(value()).toBe("16");
    fireEvent.change(field(), { target: { value: "05" } });
    fireEvent.blur(field());
    expect(field().value).toBe("5");
  });

  it("puts the last value back when left empty", () => {
    render(<Harness initial={4} min={1} />);
    fireEvent.change(field(), { target: { value: "" } });
    fireEvent.blur(field());
    expect(field().value).toBe("4");
    expect(value()).toBe("4");
  });

  it("follows a value set from outside the field", () => {
    render(<Harness initial={1} />);
    fireEvent.click(screen.getByText("preset"));
    expect(field().value).toBe("8");
  });
});
