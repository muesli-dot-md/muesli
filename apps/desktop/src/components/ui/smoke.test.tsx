/**
 * Scaffold smoke test: every shadcn primitive must be importable at runtime
 * (catches broken @base-ui/react subpath imports, missing deps, etc.) and the
 * basic building blocks must render under jsdom.
 */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Button } from "./button";
import { Badge } from "./badge";
import { Card, CardContent, CardTitle } from "./card";
import { Input } from "./input";
import { Kbd } from "./kbd";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";
import { Spinner } from "./spinner";

describe("shadcn primitives", () => {
  it("all ui modules import without throwing", async () => {
    const modules = await Promise.all([
      import("./alert-dialog"),
      import("./avatar"),
      import("./badge"),
      import("./button"),
      import("./button-group"),
      import("./card"),
      import("./checkbox"),
      import("./collapsible"),
      import("./command"),
      import("./context-menu"),
      import("./dialog"),
      import("./dropdown-menu"),
      import("./empty"),
      import("./field"),
      import("./input"),
      import("./input-group"),
      import("./item"),
      import("./kbd"),
      import("./label"),
      import("./popover"),
      import("./progress"),
      import("./resizable"),
      import("./scroll-area"),
      import("./select"),
      import("./separator"),
      import("./sheet"),
      import("./sidebar"),
      import("./skeleton"),
      import("./slider"),
      import("./sonner"),
      import("./spinner"),
      import("./switch"),
      import("./tabs"),
      import("./textarea"),
      import("./toggle"),
      import("./toggle-group"),
      import("./tooltip"),
    ]);
    for (const mod of modules) {
      expect(Object.keys(mod).length).toBeGreaterThan(0);
    }
  });

  it("renders the basic building blocks", () => {
    const { getByText } = render(
      <Card>
        <CardTitle>Muesli</CardTitle>
        <CardContent>
          <Button variant="brand">Save</Button>
          <Button variant="brandSubtle">Syncing</Button>
          <Button variant="destructive" size="xs">
            Delete
          </Button>
          <Badge>3</Badge>
          <Input placeholder="Search" />
          <Kbd>⌘K</Kbd>
          <Separator />
          <Skeleton className="h-4 w-24" />
          <Spinner />
        </CardContent>
      </Card>,
    );
    expect(getByText("Save")).toBeTruthy();
    expect(getByText("Syncing")).toBeTruthy();
  });
});
