Add-Type -AssemblyName System.Drawing

$srcPath = 'C:\Users\steph\Desktop\5starflow\.claude\screenshots\index-t2-desktop-full2.png'
$src = [System.Drawing.Bitmap]::new($srcPath)

$crops = @(
  @{name="s5-pricing-bottom-roi"; y=5200; h=800},
  @{name="s6-faq-cta"; y=5500; h=500}
)

foreach ($c in $crops) {
  $h = [Math]::Min($c.h, $src.Height - $c.y)
  if ($h -le 0) { continue }
  $rect = [System.Drawing.Rectangle]::new(0, $c.y, $src.Width, $h)
  $bmp = $src.Clone($rect, $src.PixelFormat)
  $outPath = "C:\Users\steph\Desktop\5starflow\.claude\screenshots\crop-desktop-$($c.name).png"
  $bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "Saved: $outPath"
}
$src.Dispose()
Write-Host "Done"
